import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EndToEndWebrtcConfig } from '../types.js';

// Hoisted so tests can hold a handle on the same mock the module-scoped
// `log` inside camera-stream.ts (and peer-session.ts) actually logs
// through — a fresh object per createChildLogger() call, as this used to
// mock, gives no test anything to assert against.
const { logSpy } = vi.hoisted(() => ({
  logSpy: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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

vi.mock('../utils/logger.js', async () => {
  // Keep the real scrubRtspCredentials rather than stubbing it — tests below
  // assert on its actual redaction behaviour (e.g. that a spawn error's
  // message survives scrubbing intact when it holds no credentials, and
  // that camera-stream.ts never bypasses it with a raw string).
  const actual = await vi.importActual<typeof import('../utils/logger.js')>('../utils/logger.js');
  return {
    createChildLogger: () => logSpy,
    scrubRtspCredentials: actual.scrubRtspCredentials,
  };
});

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
    // Guard against a vacuous pass: if negotiation hadn't actually completed,
    // pending would still be null, and cutOver(null) would still close
    // `previous` — satisfying the assertion below for the wrong reason.
    expect((stream as any).pending).not.toBeNull();

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

  it('logs the exact Alarm.com refusal message when a healthy active session cannot get a second session', async () => {
    // This message is the only evidence available (until the camera's WiFi
    // problem is fixed) for whether ADC permits two concurrent sessions per
    // camera — a refactor that reflows it destroys that evidence. This test
    // pins the exact substring so it cannot silently drift.
    (stream as any).ffmpeg = { kill: vi.fn(), on: vi.fn() };
    (stream as any).videoSocket = { close: vi.fn(), send: vi.fn() };
    (stream as any).videoPort = 12345;
    (stream as any)._state = 'streaming';

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

    await expect(stream.reconnect(makeConfig())).resolves.toBeUndefined();

    expect(logSpy.warn).toHaveBeenCalledWith(
      expect.objectContaining({ camera: 'test-camera', reason: 'signaling failed' }),
      expect.stringContaining(
        'Second concurrent session refused by Alarm.com — keeping the current one.',
      ),
    );
  });

  it('does not log the refusal message when the active session died mid-overlap, not a refusal', async () => {
    // A rejected pending negotiation here is a side effect of the active
    // session's own death (handleSessionFailed's discardPending tears the
    // pending down too) — it says nothing about whether ADC would have
    // permitted a second session, so it must not be logged as if it did.
    // Mirrors the mocking idiom of the 'make-before-break' describe block's
    // own mid-overlap-death test, rather than driving the full
    // PeerSession/signaling mock chain this suite otherwise uses.
    const active: any = { id: 1, close: vi.fn().mockResolvedValue(undefined) };
    (stream as any).active = active;
    (stream as any)._state = 'streaming';

    vi.spyOn(stream as any, 'tryConnect').mockResolvedValue(undefined);
    vi.spyOn(stream as any, 'negotiatePending').mockImplementation(async function (this: any) {
      this.handleSessionFailed(active); // old session dies mid-negotiation
      throw new Error('peer connection failed');
    });

    await stream.reconnect(makeConfig());

    expect(logSpy.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Second concurrent session refused by Alarm.com'),
    );
    expect(logSpy.debug).toHaveBeenCalledWith(
      expect.objectContaining({ camera: 'test-camera' }),
      expect.stringContaining('not a refusal'),
    );
  });

  it('does not lose an active-session death that lands during the pre-overlap discardPending() await', async () => {
    // Regression test: this.activeDied = false used to run AFTER the
    // `await this.discardPending(...)` at the top of reconnect(), which
    // awaits a genuine I/O close(). If the active session dies inside that
    // window, handleSessionFailed() sets activeDied = true — and the old
    // ordering would immediately wipe it back to false, so the overlap
    // settles 'kept' with the flag clear and reconnect() resolves instead
    // of falling back, even though nothing live remains.
    (stream as any)._state = 'streaming';
    (stream as any).ffmpeg = { kill: vi.fn(), on: vi.fn() };
    (stream as any).videoSocket = { close: vi.fn(), send: vi.fn() };
    (stream as any).videoPort = 12345;
    const active: any = { id: 1, close: vi.fn().mockResolvedValue(undefined) };
    (stream as any).active = active;

    // A stale pending left behind from an earlier cycle, whose close() we
    // control, so a session failure can be landed inside reconnect()'s
    // opening discardPending() await.
    let resolveClose!: () => void;
    const stalePending = {
      id: 99,
      close: vi.fn(() => new Promise<void>((resolve) => { resolveClose = resolve; })),
    };
    (stream as any).pending = stalePending;

    const tryConnectSpy = vi.spyOn(stream as any, 'tryConnect').mockResolvedValue(undefined);
    // The negotiation itself is not what's under test here — let it resolve
    // harmlessly and drive the overlap's own outcome via the budget timeout.
    vi.spyOn(stream as any, 'negotiatePending').mockResolvedValue(undefined);

    vi.useFakeTimers();
    const promise = stream.reconnect(makeConfig());

    // reconnect() has run synchronously up to `await this.discardPending(...)`,
    // which is itself parked awaiting the stale pending's close().
    (stream as any).handleSessionFailed(active);
    resolveClose();

    // Let the overlap resolve via the budget timeout (no RTP arrives).
    await vi.advanceTimersByTimeAsync(OVERLAP_BUDGET_MS);
    await promise;

    // activeDied survived the await, so reconnect() took the fallback path.
    expect(tryConnectSpy).toHaveBeenCalledTimes(1);
  });
});

describe('CameraStream.negotiatePending', () => {
  let stream: CameraStream;

  beforeEach(() => {
    stream = new CameraStream('cam-123', 'test-camera', 'rtsp://localhost:8554');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not close a session that cutOver already promoted to active before connect() rejects', async () => {
    // Fix-round MINOR 6: RTP delivery and connect()'s own promise settle
    // through entirely separate paths (see peer-session.ts) — connect() can
    // still be pending when a cutover, triggered by that session's first RTP
    // packet, already promoted it to active. If connect() later rejects,
    // negotiatePending's cleanup must not close the (now-active) session out
    // from under a stream reconnect() is about to report as a success.
    let rejectConnect!: (err: Error) => void;
    const connectSpy = vi.spyOn(PeerSession.prototype as any, 'connect').mockImplementation(
      () => new Promise((_resolve, reject) => { rejectConnect = reject; }),
    );
    const closeSpy = vi.spyOn(PeerSession.prototype, 'close').mockResolvedValue(undefined);

    const negotiatePromise = (stream as any).negotiatePending(makeConfig());
    const session = (stream as any).pending;
    expect(session).not.toBeNull();

    // Simulate the race: a cutover already promoted this exact session.
    (stream as any).active = session;
    (stream as any).pending = null;

    rejectConnect(new Error('late signaling error'));
    await expect(negotiatePromise).rejects.toThrow('late signaling error');

    expect(closeSpy).not.toHaveBeenCalled();

    connectSpy.mockRestore();
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
    // tryConnect now also waits for MEDIA, not just SESSION_STARTED. That is
    // covered by "media watchdog" below; this test is about pending-discard, so
    // the new concern is stubbed rather than simulated.
    vi.spyOn(stream as any, 'awaitMedia').mockResolvedValue(undefined);
    const connectSpy = vi.spyOn(PeerSession.prototype as any, 'connect').mockResolvedValue(undefined);

    try {
      await (stream as any).tryConnect(makeConfig());
    } finally {
      connectSpy.mockRestore();
    }

    expect(staleClose).toHaveBeenCalledTimes(1);
    expect((stream as any).pending).toBeNull();
  });

  it('reports error, not connecting, when connect() rejects', async () => {
    // start() corrects the state in its own catch, so this is invisible from
    // there. reconnect()'s fallback path calls tryConnect() DIRECTLY with no
    // such catch: a rejection there leaves the stream advertising
    // 'connecting' forever, with nothing negotiating and reconnect() refusing
    // to run again ("Cannot reconnect: expected 'streaming'").
    vi.spyOn(stream as any, 'allocateUdpPort').mockResolvedValue(12345);
    const connectSpy = vi
      .spyOn(PeerSession.prototype as any, 'connect')
      .mockRejectedValue(new Error('signaling refused'));

    try {
      await expect((stream as any).tryConnect(makeConfig())).rejects.toThrow('signaling refused');
      expect(stream.state).toBe('error');
    } finally {
      connectSpy.mockRestore();
    }
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
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('counts the first packet after a cutover as packet 1, not a continuation', () => {
    const socket = (stream as any).videoSocket;
    const active: any = { id: 1, close: vi.fn().mockResolvedValue(undefined) };
    const pending: any = { id: 2 };
    (stream as any).active = active;
    (stream as any).pending = pending;
    // rtpCount is reset only by stop(), which a make-before-break reconnect
    // deliberately never calls — so the counter carries across the cutover
    // and the "RTP packets sent to ffmpeg" confirmation, which only fires at
    // packet 1 and 100, never fires again for the life of the process. That
    // log line is the evidence that media actually resumed on the new
    // session, so losing it costs exactly the signal a cutover needs.
    (stream as any).rtpCount = 4_812;

    (stream as any).handleRtp(pending, Buffer.from([7]));

    expect((stream as any).rtpCount).toBe(1);
    expect(socket.send).toHaveBeenCalledTimes(1);
  });

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
    await vi.advanceTimersByTimeAsync(OVERLAP_BUDGET_MS);

    await expect(promise).resolves.toBeUndefined();   // must NOT throw
    expect((stream as any).active).toBe(active);      // old retained
    expect(oldClose).not.toHaveBeenCalled();
    expect((stream as any).pending).toBeNull();
    expect((stream as any).ffmpeg.kill).not.toHaveBeenCalled();
    expect(stream.state).toBe('streaming');
  });

  it('discards a previous pending rather than leaking it', async () => {
    // Fake timers so the overlap budget setTimeout armed inside reconnect()
    // (never awaited or cleared here — this test only cares about the
    // synchronous discard) doesn't run for real against the system clock.
    vi.useFakeTimers();
    const stale = { id: 5, close: vi.fn().mockResolvedValue(undefined) };
    (stream as any).active = { id: 1, close: vi.fn() };
    (stream as any).pending = stale;
    vi.spyOn(stream as any, 'negotiatePending').mockResolvedValue(undefined);

    void stream.reconnect(makeConfig()).catch(() => {});
    await Promise.resolve();

    expect(stale.close).toHaveBeenCalledTimes(1);
  });

  it('an external stop() while an overlap is in flight resolves the parked reconnect(), not hangs it', async () => {
    // Fix-round regression: negotiation succeeds, so reconnect() moves past
    // its try/catch and parks at `await outcome` with only the budget timer
    // as its stated way out. Something OUTSIDE reconnect() — in production,
    // ffmpeg dying mid-overlap triggers onUnexpectedExit -> a fresh
    // handleVideoToken() -> the full-restart branch -> tryConnect() ->
    // stop() — then discards the overlap before either the timer or a
    // cutover ever fires. Before the fix, discardPending() (called by
    // stop()) cleared the budget timer but never settled the outcome
    // promise reconnect() was still awaiting, so reconnect() never returned.
    (stream as any).active = { id: 1, close: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(stream as any, 'negotiatePending').mockResolvedValue(undefined);

    const promise = stream.reconnect(makeConfig());
    // Let reconnect() run past negotiatePending() and park at `await
    // outcome` — a real macrotask flush drains every microtask queued along
    // the way, so this doesn't depend on counting exact await hops.
    await new Promise((resolve) => setTimeout(resolve, 0));

    await stream.stop();

    await expect(promise).resolves.toBeUndefined();
  });

  it('a second reconnect() resolves the first rather than orphaning its resolver', async () => {
    // Fix-round regression, second variant of the same root cause: a second
    // reconnect() discards the first's pending via discardPending() and then
    // overwrites overlapSettle with its own resolver. Before the fix, that
    // silently orphaned the first call's resolver — nothing left could ever
    // settle it. discardPending() now settles whatever outcome is currently
    // in flight before the new one is installed.
    (stream as any).active = { id: 1, close: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(stream as any, 'negotiatePending').mockResolvedValue(undefined);

    const firstPromise = stream.reconnect(makeConfig());
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the first park at `await outcome`

    const secondPromise = stream.reconnect(makeConfig());

    await expect(firstPromise).resolves.toBeUndefined();

    // Clean up the second overlap so it doesn't leak a real 10s timer past
    // this test.
    await stream.stop();
    await expect(secondPromise).resolves.toBeUndefined();
  });

  it('logs a rejected second session distinctly, and keeps streaming', async () => {
    const active: any = { id: 1, close: vi.fn().mockResolvedValue(undefined) };
    (stream as any).active = active;
    vi.spyOn(stream as any, 'negotiatePending')
      .mockRejectedValue(new Error('SESSION_REJECTED'));

    await expect(stream.reconnect(makeConfig())).resolves.toBeUndefined();

    expect((stream as any).active).toBe(active);
    expect(stream.state).toBe('streaming');
  });

  it('falls back to break-before-make when the old session dies mid-overlap', async () => {
    const active: any = { id: 1, close: vi.fn().mockResolvedValue(undefined) };
    (stream as any).active = active;
    const fallback = vi.spyOn(stream as any, 'tryConnect').mockResolvedValue(undefined);
    vi.spyOn(stream as any, 'negotiatePending').mockImplementation(async () => {
      (stream as any).handleSessionFailed(active);   // old dies during overlap
    });

    await stream.reconnect(makeConfig());

    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('discards a still-live pending before falling back, rather than leaving it for tryConnect()', async () => {
    // Ambiguity item 4: the fallback must not run while pending is still
    // live, or tryConnect()'s own stop() would discard it and the ordering
    // becomes hard to reason about. handleSessionFailed() discards pending
    // itself, so by the time tryConnect() runs there is nothing left for it
    // to clean up.
    const active: any = { id: 1, close: vi.fn().mockResolvedValue(undefined) };
    const pendingClose = vi.fn().mockResolvedValue(undefined);
    (stream as any).active = active;
    vi.spyOn(stream as any, 'tryConnect').mockImplementation(async () => {
      // If pending were still live here, this assertion catches it.
      expect((stream as any).pending).toBeNull();
    });
    vi.spyOn(stream as any, 'negotiatePending').mockImplementation(async function (this: any) {
      this.pending = { id: 2, close: pendingClose };
      this.handleSessionFailed(active); // old dies while a pending negotiation is still live
    });

    await stream.reconnect(makeConfig());

    expect(pendingClose).toHaveBeenCalledTimes(1);
    expect((stream as any).pending).toBeNull();
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

  it('onTrackReady ignores a session that is neither active nor pending, rather than spawning an unowned ffmpeg', () => {
    // A session already discarded by stop() or a superseding reconnect (so
    // it is neither this.active nor this.pending) can still deliver a late
    // onTrackReady. Without this gate that would spawn ffmpeg for a
    // pipeline nothing feeds — harmless only by the accident of the
    // `if (this.ffmpeg) return` guard inside startFfmpeg() already holding.
    const discardedSession = { h264Fmtp: null } as any;
    (stream as any).active = null;
    (stream as any).pending = null;
    const startFfmpeg = vi.spyOn(stream as any, 'startFfmpeg').mockImplementation(() => {});

    (stream as any).sessionCallbacks.onTrackReady(discardedSession);

    expect(startFfmpeg).not.toHaveBeenCalled();
    expect((stream as any).videoSocket).toBeNull();
  });

  it('onTrackReady still starts ffmpeg for the pending session during a legitimate overlap', () => {
    // The gate must not be so broad that it blocks the pending session's own
    // onTrackReady — that is how ffmpeg ends up primed before cutOver.
    const activeSession = { h264Fmtp: null } as any;
    const pendingSession = { h264Fmtp: null } as any;
    (stream as any).active = activeSession;
    (stream as any).pending = pendingSession;
    const startFfmpeg = vi.spyOn(stream as any, 'startFfmpeg').mockImplementation(() => {});

    (stream as any).sessionCallbacks.onTrackReady(pendingSession);

    expect(startFfmpeg).toHaveBeenCalledWith(pendingSession);
    // Only the active session's onTrackReady flips state to 'streaming'.
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

  it('handleSessionFailed discards a failing pending session rather than leaving it to expire', () => {
    // A non-null pending distinct from active, so this can't pass vacuously
    // on a null === null match.
    const activeSession = { id: 1 } as any;
    const pendingClose = vi.fn().mockResolvedValue(undefined);
    const pendingSession = { id: 2, close: pendingClose };
    (stream as any).active = activeSession;
    (stream as any).pending = pendingSession;
    (stream as any)._state = 'streaming';

    (stream as any).handleSessionFailed(pendingSession);

    expect((stream as any).pending).toBeNull();
    expect(pendingClose).toHaveBeenCalledTimes(1);
    // Only the pending branch ran — the active session is untouched.
    expect(stream.state).toBe('streaming');
  });

  it('handleSessionFailed sets activeDied and discards any live pending when the active session dies', () => {
    const pendingClose = vi.fn().mockResolvedValue(undefined);
    const activeSession = { id: 1 } as any;
    const pendingSession = { id: 2, close: pendingClose };
    (stream as any).active = activeSession;
    (stream as any).pending = pendingSession;
    (stream as any)._state = 'streaming';

    (stream as any).handleSessionFailed(activeSession);

    expect(stream.state).toBe('error');
    expect((stream as any).activeDied).toBe(true);
    expect((stream as any).pending).toBeNull();
    expect(pendingClose).toHaveBeenCalledTimes(1);
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

describe('CameraStream ffmpeg spawn error', () => {
  // Without an 'error' listener on the child process, Node treats a spawn
  // failure (binary missing, PATH problem, permission error, ...) as an
  // uncaught exception and dumps it straight to stderr — including
  // err.spawnargs, the full argv, which now carries the credentialed
  // rtspUrl. This suite proves the listener exists, never lets a raw Error
  // reach the logger, and follows the same ownership gating as the 'exit'
  // handler above.
  let stream: CameraStream;
  let errorHandler: (err: Error) => void;

  beforeEach(async () => {
    stream = new CameraStream('cam-123', 'test-camera', 'rtsp://rtspuser:s3cret@127.0.0.1:8554');

    (stream as any).videoPort = 12345;
    (stream as any)._state = 'streaming';

    const { spawn } = await import('node:child_process');
    vi.mocked(spawn).mockReturnValue({
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, handler: any) => {
        if (event === 'error') errorHandler = handler;
      }),
      kill: vi.fn(),
    } as any);

    (stream as any).startFfmpeg({ h264Fmtp: null });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers an error handler on the spawned child', () => {
    expect(errorHandler).toBeTypeOf('function');
  });

  it('never logs the raw Error object, only a string message', () => {
    // spawnargs (containing the credentialed URL) lives only on the Error
    // instance itself. If any log.* call in the error handler passed the
    // raw error — e.g. `log.error({ err }, ...)` — pino's default error
    // serializer would re-surface spawnargs regardless of any scrubbing
    // done elsewhere. Assert every field of every logged object is a
    // primitive, never the Error instance.
    const err = Object.assign(new Error('spawn ffmpeg ENOENT'), {
      spawnargs: ['ffmpeg', '-i', 'rtsp://rtspuser:s3cret@127.0.0.1:8554/test-camera'],
    });

    errorHandler(err);

    const allCalls = [...logSpy.error.mock.calls, ...logSpy.warn.mock.calls, ...logSpy.info.mock.calls, ...logSpy.debug.mock.calls];
    expect(allCalls.length).toBeGreaterThan(0);
    for (const [fields] of allCalls) {
      for (const value of Object.values(fields)) {
        expect(value).not.toBeInstanceOf(Error);
        expect(JSON.stringify(value)).not.toContain('spawnargs');
      }
    }
  });

  it('does not leak credentials from the error message into the log', () => {
    const err = new Error("spawn ffmpeg failed for rtsp://rtspuser:s3cret@127.0.0.1:8554/test-camera");

    errorHandler(err);

    const loggedText = JSON.stringify(logSpy.error.mock.calls);
    expect(loggedText).not.toContain('s3cret');
    expect(loggedText).toContain('[REDACTED]');
  });

  it('sets state to error and clears the ffmpeg reference when streaming', () => {
    const callback = vi.fn();
    stream.onUnexpectedExit = callback;

    errorHandler(new Error('spawn ffmpeg ENOENT'));

    expect(stream.state).toBe('error');
    expect((stream as any).ffmpeg).toBeNull();
    expect(callback).toHaveBeenCalledOnce();
  });

  it('does not invoke onUnexpectedExit when not streaming', () => {
    const callback = vi.fn();
    stream.onUnexpectedExit = callback;
    (stream as any)._state = 'connecting';

    errorHandler(new Error('spawn ffmpeg ENOENT'));

    expect(callback).not.toHaveBeenCalled();
    expect((stream as any).ffmpeg).toBeNull();
  });

  it('ignores a late error from an intentionally stopped or superseded ffmpeg process', async () => {
    const callback = vi.fn();
    stream.onUnexpectedExit = callback;
    const staleErrorHandler = errorHandler;

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

    staleErrorHandler(new Error('spawn ffmpeg ENOENT'));

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

describe('CameraStream ffmpeg stderr scrubbing', () => {
  // ffmpeg echoes its own output URL back on stderr at -loglevel info
  // (`Output #0, rtsp, to 'rtsp://user:pass@...'`). It arrives as an object
  // VALUE under the `ffmpeg` key, so neither the pino logMethod hook (which
  // only maps message-string args) nor the `rtspUrl`/`rtspBaseUrl` entries in
  // redact.paths can reach it. The explicit scrub in the stderr handler is the
  // only thing standing between the go2rtc RTSP password and the log file.
  let stream: CameraStream;
  let stderrHandler: (data: Buffer) => void;

  beforeEach(async () => {
    stream = new CameraStream('cam-123', 'test-camera', 'rtsp://rtspuser:s3cret@127.0.0.1:8554');

    (stream as any).videoPort = 12345;
    (stream as any)._state = 'streaming';

    const { spawn } = await import('node:child_process');
    vi.mocked(spawn).mockReturnValue({
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: {
        on: vi.fn((event: string, handler: any) => {
          if (event === 'data') stderrHandler = handler;
        }),
      },
      on: vi.fn(),
      kill: vi.fn(),
    } as any);

    (stream as any).startFfmpeg({ h264Fmtp: null });

    // startFfmpeg itself logs `{ rtspUrl }` on the way in. That field is
    // covered by pino's redact.paths in production, but this suite mocks the
    // logger, so drop those calls and assert only on what the stderr handler
    // logs.
    logSpy.info.mockClear();
    logSpy.debug.mockClear();
    logSpy.warn.mockClear();
    logSpy.error.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers a data handler on the child stderr stream', () => {
    expect(stderrHandler).toBeTypeOf('function');
  });

  it('never logs the RTSP password from ffmpeg stderr', () => {
    stderrHandler(
      Buffer.from(
        "Output #0, rtsp, to 'rtsp://rtspuser:s3cret@127.0.0.1:8554/test-camera':\n",
      ),
    );

    const allCalls = [
      ...logSpy.info.mock.calls,
      ...logSpy.debug.mock.calls,
      ...logSpy.warn.mock.calls,
      ...logSpy.error.mock.calls,
    ];
    expect(allCalls.length).toBeGreaterThan(0);

    const loggedText = JSON.stringify(allCalls);
    expect(loggedText).not.toContain('s3cret');
    expect(loggedText).not.toContain('rtspuser');
    expect(loggedText).toContain('[REDACTED]');
    // The line is still useful — only the userinfo is removed.
    expect(loggedText).toContain('127.0.0.1:8554/test-camera');
  });

  it('scrubs credentials on the debug (progress-line) path too', () => {
    // Contrived: a progress line would not normally carry a URL. The point is
    // that the scrub happens before the info/debug branch, so neither path can
    // grow a leak independently of the other.
    stderrHandler(
      Buffer.from('frame= 42 fps=10 rtsp://rtspuser:s3cret@127.0.0.1:8554/test-camera'),
    );

    const loggedText = JSON.stringify(logSpy.debug.mock.calls);
    expect(logSpy.debug).toHaveBeenCalled();
    expect(logSpy.info).not.toHaveBeenCalled();
    expect(loggedText).not.toContain('s3cret');
    expect(loggedText).toContain('[REDACTED]');
  });

  it('leaves a credential-free line intact', () => {
    stderrHandler(Buffer.from('  Stream #0:0: Video: h264, yuv420p, 1920x1080  \n'));

    expect(logSpy.info).toHaveBeenCalledWith(
      { camera: 'test-camera', ffmpeg: 'Stream #0:0: Video: h264, yuv420p, 1920x1080' },
      'ffmpeg',
    );
  });

  it('ignores an empty chunk', () => {
    stderrHandler(Buffer.from('   \n'));

    expect(logSpy.info).not.toHaveBeenCalled();
    expect(logSpy.debug).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 SESSION_STARTED is not media. Without the watchdog, a session that
 * negotiates and then delivers nothing resolves start(), CameraManager calls
 * breaker.recordSuccess(), and the breaker meant to catch exactly this is
 * reset — while state sits at 'connecting' forever.
 */
describe('CameraStream media watchdog', () => {
  let stream: CameraStream;

  beforeEach(() => {
    stream = new CameraStream('cam-1', 'front', 'rtsp://127.0.0.1:8554');
    vi.spyOn(stream as any, 'allocateUdpPort').mockResolvedValue(12345);
    vi.spyOn(stream as any, 'startFfmpeg').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('REJECTS when the handshake succeeds but no track ever arrives', async () => {
    vi.useFakeTimers();
    vi.spyOn(PeerSession.prototype as any, 'connect').mockResolvedValue(undefined);
    vi.spyOn(stream, 'stop').mockImplementation(async () => { (stream as any).active = null; });

    const attempt = (stream as any).tryConnect(makeConfig());
    const assertion = expect(attempt).rejects.toThrow(/no media within/);
    await vi.advanceTimersByTimeAsync(21_000);
    await assertion;
  });

  it('leaves state at error, not connecting, after a media timeout', async () => {
    vi.useFakeTimers();
    vi.spyOn(PeerSession.prototype as any, 'connect').mockResolvedValue(undefined);
    vi.spyOn(stream, 'stop').mockImplementation(async () => { (stream as any).active = null; });

    const attempt = (stream as any).tryConnect(makeConfig()).catch(() => {});
    await vi.advanceTimersByTimeAsync(21_000);
    await attempt;
    // 🔴 'connecting' is the bug: the status endpoint then reports a
    // connection in progress that nothing is progressing.
    expect(stream.state).toBe('error');
  });

  // Positive control — without this, a watchdog that ALWAYS rejected would pass
  // the two tests above.
  it('RESOLVES when the active session delivers a track', async () => {
    vi.spyOn(PeerSession.prototype as any, 'connect').mockResolvedValue(undefined);
    const attempt = (stream as any).tryConnect(makeConfig());

    // tryConnect awaits stop(), discardPending() and allocateUdpPort() before
    // installing `active` — a single microtask turn is not enough, and firing
    // the callback with a null session makes onTrackReady return early
    // (correctly: a track from a discarded session must be ignored).
    for (let i = 0; i < 50 && !(stream as any).active; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect((stream as any).active, 'active session was never installed').not.toBeNull();

    (stream as any).sessionCallbacks.onTrackReady((stream as any).active);
    await expect(attempt).resolves.toBeUndefined();
    expect(stream.state).toBe('streaming');
  });

  it('resolves immediately when the track beat connect() resolving', async () => {
    // onTrackReady can fire before connect()'s promise settles; a watchdog that
    // missed that race would fail a perfectly healthy stream.
    (stream as any)._state = 'streaming';
    await expect((stream as any).awaitMedia()).resolves.toBeUndefined();
  });

  it('does not let a later track settle a waiter a stop() abandoned', async () => {
    vi.useFakeTimers();
    const pending = (stream as any).awaitMedia();
    const guard = expect(pending).rejects.toThrow(/no media/);
    await stream.stop();
    expect((stream as any).settleMedia).toBeNull();
    await vi.advanceTimersByTimeAsync(21_000);
    await guard;
  });
});
