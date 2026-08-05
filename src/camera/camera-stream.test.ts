import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EndToEndWebrtcConfig } from '../types.js';

vi.mock('werift', () => ({
  RTCPeerConnection: vi.fn(),
  RTCRtpCodecParameters: vi.fn(),
}));

vi.mock('../signaling/signaling-client.js', () => ({
  SignalingClient: vi.fn().mockImplementation(function () {
    return {
      on: vi.fn(),
      removeAllListeners: vi.fn(),
      close: vi.fn(),
      connect: vi.fn(),
      sendAnswer: vi.fn(),
      sendIceCandidate: vi.fn(),
    };
  }),
}));

vi.mock('node:dgram', () => ({
  createSocket: vi.fn().mockReturnValue({
    bind: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    send: vi.fn(),
  }),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../utils/retry.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

import { CameraStream, OVERLAP_BUDGET_MS } from './camera-stream.js';
import { PeerSession } from './peer-session.js';
import { SignalingClient } from '../signaling/signaling-client.js';
import { sleep } from '../utils/retry.js';

const makeConfig = (): EndToEndWebrtcConfig => ({
  signallingServerUrl: 'wss://example.com',
  signallingServerToken: 'token',
  cameraAuthToken: 'auth',
  supportsAudio: false,
  supportsFullDuplex: false,
  iceServers: [],
});

describe('CameraStream.start', () => {
  let stream: CameraStream;

  beforeEach(() => {
    stream = new CameraStream('cam-123', 'test-camera', 'rtsp://localhost:8554');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns successfully when tryConnect succeeds on first attempt', async () => {
    vi.spyOn(stream as any, 'tryConnect').mockResolvedValue(undefined);

    await expect(stream.start(makeConfig())).resolves.toBeUndefined();
    expect((stream as any).tryConnect).toHaveBeenCalledTimes(1);
  });

  it('retries on dial-in error and succeeds on subsequent attempt', async () => {
    const tryConnect = vi.spyOn(stream as any, 'tryConnect')
      .mockRejectedValueOnce(new Error('Camera has not yet dialed in'))
      .mockResolvedValue(undefined);

    await expect(stream.start(makeConfig())).resolves.toBeUndefined();
    expect(tryConnect).toHaveBeenCalledTimes(2);
  });

  it('throws and sets state to error after exhausting all dial-in retries', async () => {
    vi.spyOn(stream as any, 'tryConnect')
      .mockRejectedValue(new Error('Camera has not yet dialed in'));

    await expect(stream.start(makeConfig())).rejects.toThrow(
      'Camera has not yet dialed in',
    );
    expect(stream.state).toBe('error');
  });

  it('throws immediately on non-dial-in errors without retrying', async () => {
    vi.spyOn(stream as any, 'tryConnect')
      .mockRejectedValue(new Error('Connection refused'));

    await expect(stream.start(makeConfig())).rejects.toThrow('Connection refused');
    expect(stream.state).toBe('error');
    expect((stream as any).tryConnect).toHaveBeenCalledTimes(1);
  });

  it('calls refetchToken between dial-in retries and uses fresh config', async () => {
    const freshConfig = makeConfig();
    freshConfig.signallingServerToken = 'fresh-token';
    const refetchToken = vi.fn().mockResolvedValue(freshConfig);

    vi.spyOn(stream as any, 'tryConnect')
      .mockRejectedValueOnce(new Error('Camera has not yet dialed in'))
      .mockResolvedValue(undefined);

    await stream.start(makeConfig(), refetchToken);

    expect(refetchToken).toHaveBeenCalledTimes(1);
    expect((stream as any).tryConnect).toHaveBeenCalledTimes(2);
    expect((stream as any).tryConnect).toHaveBeenLastCalledWith(freshConfig);
  });

  it('keeps original config when refetchToken returns null', async () => {
    const originalConfig = makeConfig();
    const refetchToken = vi.fn().mockResolvedValue(null);

    vi.spyOn(stream as any, 'tryConnect')
      .mockRejectedValueOnce(new Error('Camera has not yet dialed in'))
      .mockResolvedValue(undefined);

    await stream.start(originalConfig, refetchToken);

    expect(refetchToken).toHaveBeenCalledTimes(1);
    expect((stream as any).tryConnect).toHaveBeenLastCalledWith(originalConfig);
  });

  it('handles non-Error thrown values from tryConnect', async () => {
    vi.spyOn(stream as any, 'tryConnect')
      .mockRejectedValue('string error');

    await expect(stream.start(makeConfig())).rejects.toBe('string error');
    expect(stream.state).toBe('error');
  });

  it('uses longer delay (15s) for early attempts and shorter (10s) for later', async () => {
    const mockedSleep = vi.mocked(sleep);

    vi.spyOn(stream as any, 'tryConnect')
      .mockRejectedValueOnce(new Error('Camera has not yet dialed in')) // attempt 1
      .mockRejectedValueOnce(new Error('Camera has not yet dialed in')) // attempt 2
      .mockRejectedValueOnce(new Error('Camera has not yet dialed in')) // attempt 3
      .mockResolvedValue(undefined); // attempt 4

    await stream.start(makeConfig());

    expect(mockedSleep).toHaveBeenCalledTimes(3);
    expect(mockedSleep).toHaveBeenNthCalledWith(1, 15_000); // attempt 1 → 15s
    expect(mockedSleep).toHaveBeenNthCalledWith(2, 15_000); // attempt 2 → 15s
    expect(mockedSleep).toHaveBeenNthCalledWith(3, 10_000); // attempt 3 → 10s
  });

  it('calls stop() to clean up between dial-in retries', async () => {
    const stopSpy = vi.spyOn(stream, 'stop').mockResolvedValue(undefined);

    vi.spyOn(stream as any, 'tryConnect')
      .mockRejectedValueOnce(new Error('Camera has not yet dialed in'))
      .mockResolvedValue(undefined);

    await stream.start(makeConfig());

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('retries without refetchToken when none is provided', async () => {
    vi.spyOn(stream as any, 'tryConnect')
      .mockRejectedValueOnce(new Error('Camera has not yet dialed in'))
      .mockRejectedValueOnce(new Error('Camera has not yet dialed in'))
      .mockResolvedValue(undefined);

    await expect(stream.start(makeConfig())).resolves.toBeUndefined();
    expect((stream as any).tryConnect).toHaveBeenCalledTimes(3);
  });

  it('propagates error when refetchToken itself throws', async () => {
    const refetchToken = vi.fn().mockRejectedValue(new Error('auth expired'));

    vi.spyOn(stream as any, 'tryConnect')
      .mockRejectedValueOnce(new Error('Camera has not yet dialed in'));

    await expect(stream.start(makeConfig(), refetchToken)).rejects.toThrow('auth expired');
  });
});

describe('CameraStream.reconnect', () => {
  let stream: CameraStream;

  beforeEach(() => {
    stream = new CameraStream('cam-123', 'test-camera', 'rtsp://localhost:8554');
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  function setupReconnectMocks() {
    // Stub internal methods that depend on werift mocks. These now live on
    // PeerSession, which CameraStream.reconnect() creates internally.
    vi.spyOn(PeerSession.prototype as any, 'createPeerConnection').mockReturnValue({});
    vi.spyOn(PeerSession.prototype as any, 'setupPeerConnection').mockImplementation(() => {});
    vi.spyOn(PeerSession.prototype as any, 'registerPostSessionHandlers').mockImplementation(() => {});
  }

  function mockSignalingToSucceed() {
    vi.mocked(SignalingClient).mockImplementation(function () {
      return {
        on: vi.fn((event: string, handler: any) => {
          if (event === 'sessionStarted') setTimeout(handler, 0);
        }),
        removeAllListeners: vi.fn(),
        close: vi.fn(),
        connect: vi.fn().mockResolvedValue(undefined),
        sendAnswer: vi.fn(),
        sendIceCandidate: vi.fn(),
      } as any;
    });
  }

  it('does not kill ffmpeg or videoSocket during reconnect', async () => {
    const mockFfmpeg = { kill: vi.fn(), on: vi.fn() };
    const mockSocket = { close: vi.fn(), send: vi.fn() };

    (stream as any).ffmpeg = mockFfmpeg;
    (stream as any).videoSocket = mockSocket;
    (stream as any).videoPort = 12345;
    (stream as any)._state = 'streaming';

    setupReconnectMocks();
    mockSignalingToSucceed();

    // reconnect() now resolves on the overlap's outcome, not on negotiation
    // alone — with no RTP to trigger cutover, that outcome is the budget
    // timeout ('kept'). Either outcome leaves ffmpeg/videoSocket untouched.
    vi.useFakeTimers();
    const promise = stream.reconnect(makeConfig());
    await vi.advanceTimersByTimeAsync(OVERLAP_BUDGET_MS);
    await expect(promise).resolves.toBeUndefined();

    expect(mockFfmpeg.kill).not.toHaveBeenCalled();
    expect(mockSocket.close).not.toHaveBeenCalled();
  });

  it('closes the old session only after cutover, never before', async () => {
    const oldClose = vi.fn().mockResolvedValue(undefined);
    (stream as any).active = { id: 1, close: oldClose };
    (stream as any).ffmpeg = { kill: vi.fn(), on: vi.fn() };
    (stream as any).videoSocket = { close: vi.fn(), send: vi.fn() };
    (stream as any).videoPort = 12345;
    (stream as any)._state = 'streaming';

    setupReconnectMocks();
    mockSignalingToSucceed();

    // reconnect() no longer resolves once negotiation completes — it awaits
    // the overlap outcome — so it is kicked off without awaiting it yet.
    vi.useFakeTimers();
    const promise = stream.reconnect(makeConfig());

    // negotiatePending() resolves once signaling reports SESSION_STARTED —
    // well before any RTP, and therefore well before cutover. The old
    // session must still be untouched at that point.
    await vi.advanceTimersByTimeAsync(0);
    expect(oldClose).not.toHaveBeenCalled();

    (stream as any).handleRtp((stream as any).pending, Buffer.from([1]));
    await promise;
    expect(oldClose).toHaveBeenCalledTimes(1);
  });

  it('keeps state streaming throughout the overlap', async () => {
    (stream as any).ffmpeg = { kill: vi.fn(), on: vi.fn() };
    (stream as any).videoSocket = { close: vi.fn(), send: vi.fn() };
    (stream as any).videoPort = 12345;
    (stream as any)._state = 'streaming';

    let capturedState: string | undefined;

    setupReconnectMocks();

    vi.mocked(SignalingClient).mockImplementation(function () {
      return {
        on: vi.fn((event: string, handler: any) => {
          if (event === 'sessionStarted') {
            capturedState = stream.state;
            setTimeout(handler, 0);
          }
        }),
        removeAllListeners: vi.fn(),
        close: vi.fn(),
        connect: vi.fn().mockResolvedValue(undefined),
        sendAnswer: vi.fn(),
        sendIceCandidate: vi.fn(),
      } as any;
    });

    // No RTP arrives in this test, so the overlap resolves via the budget
    // timeout rather than cutover — state must stay 'streaming' either way.
    vi.useFakeTimers();
    const promise = stream.reconnect(makeConfig());
    await vi.advanceTimersByTimeAsync(OVERLAP_BUDGET_MS);
    await promise;

    // Never 'connecting' — the old session is still live and feeding
    // ffmpeg for the whole negotiation, so nothing about the stream state
    // changes until cutover.
    expect(capturedState).toBe('streaming');
    expect(stream.state).toBe('streaming');
  });

  it('resolves (does not throw) and leaves the still-live active session and state alone when negotiation fails', async () => {
    (stream as any).ffmpeg = { kill: vi.fn(), on: vi.fn() };
    (stream as any).videoSocket = { close: vi.fn(), send: vi.fn() };
    (stream as any).videoPort = 12345;
    (stream as any)._state = 'streaming';
    const activeClose = vi.fn().mockResolvedValue(undefined);
    (stream as any).active = { id: 1, close: activeClose };

    setupReconnectMocks();

    vi.mocked(SignalingClient).mockImplementation(function () {
      return {
        on: vi.fn((event: string, handler: any) => {
          if (event === 'error') setTimeout(() => handler(new Error('signaling failed')), 0);
        }),
        removeAllListeners: vi.fn(),
        close: vi.fn(),
        connect: vi.fn().mockResolvedValue(undefined),
        sendAnswer: vi.fn(),
        sendIceCandidate: vi.fn(),
      } as any;
    });

    // A failed pending negotiation does not touch the still-good active
    // session: media is still flowing, so there is nothing to error out —
    // and reconnect() resolves rather than throwing, so a caller does not
    // record this harmless failure against the circuit breaker.
    await expect(stream.reconnect(makeConfig())).resolves.toBeUndefined();
    expect(stream.state).toBe('streaming');
    expect(activeClose).not.toHaveBeenCalled();
  });

  it('closes and clears pending when negotiation fails', async () => {
    (stream as any).ffmpeg = { kill: vi.fn(), on: vi.fn() };
    (stream as any).videoSocket = { close: vi.fn(), send: vi.fn() };
    (stream as any).videoPort = 12345;
    (stream as any)._state = 'streaming';

    setupReconnectMocks();
    // PeerSession.connect() does not clean up after itself on rejection — it
    // leaves the RTCPeerConnection and signaling WebSocket live. Spy on the
    // real close() rather than relying on the stubbed pc's own (absent)
    // close method, so this asserts negotiatePending's own cleanup ran.
    const closeSpy = vi.spyOn(PeerSession.prototype, 'close').mockResolvedValue(undefined);

    vi.mocked(SignalingClient).mockImplementation(function () {
      return {
        on: vi.fn((event: string, handler: any) => {
          if (event === 'error') setTimeout(() => handler(new Error('signaling failed')), 0);
        }),
        removeAllListeners: vi.fn(),
        close: vi.fn(),
        connect: vi.fn().mockResolvedValue(undefined),
        sendAnswer: vi.fn(),
        sendIceCandidate: vi.fn(),
      } as any;
    });

    // Task 4: reconnect() resolves rather than rejecting on a failed
    // negotiation — see the previous test for why.
    await expect(stream.reconnect(makeConfig())).resolves.toBeUndefined();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect((stream as any).pending).toBeNull();

    closeSpy.mockRestore();
  });
});

describe('CameraStream.tryConnect', () => {
  let stream: CameraStream;

  beforeEach(() => {
    stream = new CameraStream('cam-123', 'test-camera', 'rtsp://localhost:8554');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('discards a stale pending session before installing a fresh active, independent of stop()', async () => {
    const staleClose = vi.fn().mockResolvedValue(undefined);
    (stream as any).pending = { id: 9, close: staleClose };

    // Simulate stop() leaving pending behind, so this asserts tryConnect's
    // own discard — not just the one inherited by calling stop() first.
    vi.spyOn(stream, 'stop').mockImplementation(async () => {
      (stream as any).active = null;
    });
    vi.spyOn(stream as any, 'allocateUdpPort').mockResolvedValue(12345);
    const connectSpy = vi.spyOn(PeerSession.prototype as any, 'connect').mockResolvedValue(undefined);

    try {
      await (stream as any).tryConnect(makeConfig());
    } finally {
      connectSpy.mockRestore();
    }

    expect(staleClose).toHaveBeenCalledTimes(1);
    expect((stream as any).pending).toBeNull();
  });
});

describe('CameraStream make-before-break', () => {
  let stream: CameraStream;
  beforeEach(() => {
    stream = new CameraStream('cam-123', 'test-camera', 'rtsp://localhost:8554');
    (stream as any).ffmpeg = { kill: vi.fn(), on: vi.fn() };
    (stream as any).videoSocket = { send: vi.fn(), close: vi.fn() };
    (stream as any).videoPort = 12345;
    (stream as any)._state = 'streaming';
  });
  afterEach(() => vi.clearAllMocks());

  it('does not forward pending RTP before cutover', () => {
    const socket = (stream as any).videoSocket;
    const active: any = { id: 1, close: vi.fn().mockResolvedValue(undefined) };
    const pending: any = { id: 2 };
    (stream as any).active = active;
    (stream as any).pending = pending;

    (stream as any).handleRtp(pending, Buffer.from([7]));

    // The cutover consumes this very packet, so exactly one send occurs and
    // the two sessions are never both forwarding.
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect((stream as any).active).toBe(pending);
  });

  it('closes the old session only after cutover, never before', async () => {
    const oldClose = vi.fn().mockResolvedValue(undefined);
    const active: any = { id: 1, close: oldClose };
    const pending: any = { id: 2, close: vi.fn() };
    (stream as any).active = active;
    (stream as any).pending = pending;

    expect(oldClose).not.toHaveBeenCalled();
    (stream as any).cutOver(pending);
    expect(oldClose).toHaveBeenCalledTimes(1);
    expect((stream as any).pending).toBeNull();
    // The whole point: the RTSP publisher is never disturbed.
    expect((stream as any).ffmpeg.kill).not.toHaveBeenCalled();
    expect((stream as any).videoSocket.close).not.toHaveBeenCalled();
  });

  // 'keeps state streaming throughout the overlap' is covered more strongly
  // in the 'CameraStream.reconnect' describe above, which captures state at
  // the moment signaling reports sessionStarted. A version of this test used
  // to live here too, spying on negotiatePending and swallowing its own
  // rejection with .catch(() => {}) — that made it pass vacuously, since the
  // outer assertion was already satisfied by beforeEach whether or not the
  // mocked negotiatePending ever ran. Removed rather than duplicated.

  it('stop() closes and clears a pending overlap session', async () => {
    const pendingClose = vi.fn().mockResolvedValue(undefined);
    (stream as any).active = { id: 1, close: vi.fn().mockResolvedValue(undefined) };
    (stream as any).pending = { id: 2, close: pendingClose };

    await stream.stop();

    // An abandoned pending is not inert — see the CameraStream make-before-
    // break describe above — so stop() must release it just like active.
    expect(pendingClose).toHaveBeenCalledTimes(1);
    expect((stream as any).pending).toBeNull();
  });

  it('cutOver refuses to promote a pending session once the stream is no longer streaming', () => {
    const activeClose = vi.fn().mockResolvedValue(undefined);
    const pendingClose = vi.fn().mockResolvedValue(undefined);
    const active: any = { id: 1, close: activeClose };
    const pending: any = { id: 2, close: pendingClose };
    (stream as any).active = active;
    (stream as any).pending = pending;
    // e.g. ffmpeg died mid-negotiation and handleSessionFailed/stop() already
    // moved the stream out of 'streaming'.
    (stream as any)._state = 'error';

    (stream as any).cutOver(pending);

    // The stray RTP that triggered this must not resurrect a torn-down (or
    // otherwise no-longer-streaming) pipeline: no promotion, and the
    // orphaned session is still released rather than leaked.
    expect((stream as any).active).toBe(active);
    expect((stream as any).pending).toBeNull();
    expect(pendingClose).toHaveBeenCalledTimes(1);
    expect(activeClose).not.toHaveBeenCalled();
  });

  it('keeps the old session and does not throw when the new one never delivers', async () => {
    vi.useFakeTimers();
    const oldClose = vi.fn().mockResolvedValue(undefined);
    const active: any = { id: 1, close: oldClose };
    (stream as any).active = active;
    vi.spyOn(stream as any, 'negotiatePending').mockResolvedValue(undefined);

    const promise = stream.reconnect(makeConfig());
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(promise).resolves.toBeUndefined();   // must NOT throw
    expect((stream as any).active).toBe(active);      // old retained
    expect(oldClose).not.toHaveBeenCalled();
    expect((stream as any).pending).toBeNull();
    expect((stream as any).ffmpeg.kill).not.toHaveBeenCalled();
    expect(stream.state).toBe('streaming');
    vi.useRealTimers();
  });

  it('discards a previous pending rather than leaking it', async () => {
    const stale = { id: 5, close: vi.fn().mockResolvedValue(undefined) };
    (stream as any).active = { id: 1, close: vi.fn() };
    (stream as any).pending = stale;
    vi.spyOn(stream as any, 'negotiatePending').mockResolvedValue(undefined);

    void stream.reconnect(makeConfig()).catch(() => {});
    await Promise.resolve();

    expect(stale.close).toHaveBeenCalledTimes(1);
  });
});

describe('CameraStream session callbacks', () => {
  let stream: CameraStream;

  beforeEach(() => {
    stream = new CameraStream('cam-123', 'test-camera', 'rtsp://localhost:8554');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('onTrackReady starts ffmpeg, creates the video socket, and marks the active session streaming', () => {
    const session = { h264Fmtp: null } as any;
    (stream as any).active = session;
    const startFfmpeg = vi.spyOn(stream as any, 'startFfmpeg').mockImplementation(() => {});

    (stream as any).sessionCallbacks.onTrackReady(session);

    expect(startFfmpeg).toHaveBeenCalledWith(session);
    expect((stream as any).videoSocket).not.toBeNull();
    expect(stream.state).toBe('streaming');
  });

  it('onTrackReady does not mark the stream streaming for a session that is no longer active', () => {
    const activeSession = { h264Fmtp: null } as any;
    const staleSession = { h264Fmtp: null } as any;
    (stream as any).active = activeSession;
    vi.spyOn(stream as any, 'startFfmpeg').mockImplementation(() => {});

    (stream as any).sessionCallbacks.onTrackReady(staleSession);

    expect(stream.state).not.toBe('streaming');
  });

  it('onRtp forwards packets from the active session to the video socket', () => {
    const session = { id: 1 } as any;
    const mockSocket = { send: vi.fn(), close: vi.fn() };
    (stream as any).active = session;
    (stream as any).videoSocket = mockSocket;
    (stream as any).videoPort = 12345;

    const packet = Buffer.from([1, 2, 3]);
    (stream as any).sessionCallbacks.onRtp(session, packet);

    expect(mockSocket.send).toHaveBeenCalledWith(packet, 12345, '127.0.0.1');
  });

  // pending is explicitly nulled here (rather than left at its default) so
  // this exercises the "neither" case directly: otherSession must be
  // rejected by both halves of the active-or-pending gate, not just by
  // happening to not be active.
  it('onRtp ignores packets from a session that is neither active nor pending', () => {
    const activeSession = { id: 1 } as any;
    const otherSession = { id: 99 } as any;
    const mockSocket = { send: vi.fn(), close: vi.fn() };
    (stream as any).active = activeSession;
    (stream as any).pending = null;
    (stream as any).videoSocket = mockSocket;
    (stream as any).videoPort = 12345;

    (stream as any).sessionCallbacks.onRtp(otherSession, Buffer.from([1, 2, 3]));

    expect(mockSocket.send).not.toHaveBeenCalled();
  });

  it('handleSessionFailed sets state to error for the active session', () => {
    const session = {} as any;
    (stream as any).active = session;
    (stream as any)._state = 'streaming';

    (stream as any).handleSessionFailed(session);

    expect(stream.state).toBe('error');
  });

  it('handleSessionFailed leaves state alone for a session that is no longer active', () => {
    const activeSession = {} as any;
    const staleSession = {} as any;
    (stream as any).active = activeSession;
    (stream as any)._state = 'streaming';

    (stream as any).handleSessionFailed(staleSession);

    expect(stream.state).toBe('streaming');
  });
});

describe('CameraStream ffmpeg mid-stream exit recovery', () => {
  let stream: CameraStream;
  let exitHandler: (code: number | null) => void;

  beforeEach(async () => {
    stream = new CameraStream('cam-123', 'test-camera', 'rtsp://localhost:8554');

    (stream as any).videoPort = 12345;
    (stream as any)._state = 'streaming';

    const { spawn } = await import('node:child_process');
    vi.mocked(spawn).mockReturnValue({
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, handler: any) => {
        if (event === 'exit') exitHandler = handler;
      }),
      kill: vi.fn(),
    } as any);

    (stream as any).startFfmpeg({ h264Fmtp: null });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sets state to error when ffmpeg exits while streaming', () => {
    exitHandler(1);

    expect(stream.state).toBe('error');
  });

  it('invokes onUnexpectedExit callback when ffmpeg exits while streaming', () => {
    const callback = vi.fn();
    stream.onUnexpectedExit = callback;

    exitHandler(0);

    expect(callback).toHaveBeenCalledOnce();
  });

  it('does not invoke callback when ffmpeg exits during idle/connecting state', () => {
    const callback = vi.fn();
    stream.onUnexpectedExit = callback;
    (stream as any)._state = 'idle';

    exitHandler(0);

    expect(callback).not.toHaveBeenCalled();
  });

  it('does not set state to error when stream is already idle', () => {
    (stream as any)._state = 'idle';

    exitHandler(0);

    expect(stream.state).toBe('idle');
  });

  it('ignores a late exit from an intentionally stopped ffmpeg process', async () => {
    const callback = vi.fn();
    stream.onUnexpectedExit = callback;

    const ffmpeg = (stream as any).ffmpeg;
    ffmpeg.kill.mockImplementation(() => exitHandler(0));

    await stream.stop();

    expect(ffmpeg.kill).toHaveBeenCalledWith('SIGTERM');
    expect((stream as any).ffmpeg).toBeNull();
    expect(stream.state).toBe('idle');
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not clear or restart a replacement when an older ffmpeg exits', async () => {
    const callback = vi.fn();
    stream.onUnexpectedExit = callback;
    const staleExitHandler = exitHandler;

    const { spawn } = await import('node:child_process');
    const replacement = {
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    } as any;
    vi.mocked(spawn).mockReturnValue(replacement);

    (stream as any).ffmpeg = null;
    (stream as any).startFfmpeg({ h264Fmtp: null });
    expect((stream as any).ffmpeg).toBe(replacement);

    staleExitHandler(0);

    expect((stream as any).ffmpeg).toBe(replacement);
    expect(stream.state).toBe('streaming');
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('CameraStream ffmpeg SDP', () => {
  let stream: CameraStream;
  let stdinWrite: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    stream = new CameraStream('cam-123', 'test-camera', 'rtsp://localhost:8554');

    // Allocate a port so startFfmpeg doesn't bail
    (stream as any).videoPort = 12345;

    // Mock spawn to capture what gets written to ffmpeg's stdin
    stdinWrite = vi.fn();
    const { spawn } = await import('node:child_process');
    vi.mocked(spawn).mockReturnValue({
      stdin: { write: stdinWrite, end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('includes parsed h264Fmtp in ffmpeg SDP', () => {
    (stream as any).startFfmpeg({
      h264Fmtp: 'packetization-mode=1;profile-level-id=4d001f;sprop-parameter-sets=Z00AH+dA==,aO48gA==',
    });

    expect(stdinWrite).toHaveBeenCalledWith(
      expect.stringContaining('a=fmtp:96 packetization-mode=1;profile-level-id=4d001f;sprop-parameter-sets=Z00AH+dA==,aO48gA=='),
    );
  });

  it('falls back to default fmtp when h264Fmtp is null', () => {
    (stream as any).startFfmpeg({ h264Fmtp: null });

    expect(stdinWrite).toHaveBeenCalledWith(
      expect.stringContaining('a=fmtp:96 packetization-mode=1'),
    );
    expect(stdinWrite).not.toHaveBeenCalledWith(
      expect.stringContaining('profile-level-id'),
    );
  });

  it('prepends packetization-mode=1 when missing from camera fmtp', () => {
    (stream as any).startFfmpeg({ h264Fmtp: 'profile-level-id=4d001f' });

    expect(stdinWrite).toHaveBeenCalledWith(
      expect.stringContaining('a=fmtp:96 packetization-mode=1;profile-level-id=4d001f'),
    );
  });
});
