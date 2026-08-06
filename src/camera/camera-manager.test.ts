import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { EndToEndWebrtcConfig } from '../types.js';

vi.mock('../utils/logger.js', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Stub CameraStream so we can control start()/stop()/reconnect() behavior
vi.mock('./camera-stream.js', () => ({
  CameraStream: vi.fn().mockImplementation(function (_id: string, name: string) {
    return {
      cameraId: _id,
      cameraName: name,
      state: 'idle',
      onUnexpectedExit: null,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      reconnect: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

import { CameraManager } from './camera-manager.js';
import { TokenManager } from '../auth/token-manager.js';

const makeConfig = (): EndToEndWebrtcConfig => ({
  signallingServerUrl: 'wss://example.com',
  signallingServerToken: 'token',
  cameraAuthToken: 'auth',
  supportsAudio: false,
  supportsFullDuplex: false,
  iceServers: [],
});

/** Create a minimal TokenManager stub that extends EventEmitter. */
function createTokenManagerStub() {
  const stub = Object.assign(new EventEmitter(), {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    fetchVideoToken: vi.fn().mockResolvedValue(null),
    fetchVideoTokenSilent: vi.fn().mockResolvedValue(null),
    circuitState: vi.fn().mockReturnValue('closed' as const),
    circuitFailures: vi.fn().mockReturnValue(0),
    circuitRetryAfterMs: vi.fn().mockReturnValue(0),
  });
  return stub as unknown as TokenManager & typeof stub;
}

describe('CameraManager backoff', () => {
  let manager: CameraManager;
  let tokenManager: ReturnType<typeof createTokenManagerStub>;

  beforeEach(() => {
    vi.useFakeTimers();
    tokenManager = createTokenManagerStub();
    manager = new CameraManager(tokenManager, 'rtsp://localhost:8554');
  });

  afterEach(async () => {
    await manager.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function startWithCamera() {
    await manager.start([{ id: 'cam-1', name: 'driveway', quality: 'hd' as const }]);
  }

  function getStream(): any {
    const status = manager.getStatus();
    // Access the internal stream via the streams map
    return (manager as any).streams.get('cam-1');
  }

  it('retries with 30s delay on first failure', async () => {
    await startWithCamera();
    const stream = getStream();
    stream.start.mockRejectedValueOnce(new Error('dial-in failed'));

    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0); // let handleVideoToken run

    expect(tokenManager.fetchVideoToken).not.toHaveBeenCalledWith('cam-1');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(tokenManager.fetchVideoToken).toHaveBeenCalledWith('cam-1');
  });

  it('increases delay on consecutive failures: 30s → 60s → 120s', async () => {
    await startWithCamera();
    const stream = getStream();
    stream.start.mockRejectedValue(new Error('camera offline'));

    // Failure 1 → 30s backoff
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);
    tokenManager.fetchVideoToken.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(tokenManager.fetchVideoToken).toHaveBeenCalledTimes(1);

    // Failure 2 → 60s backoff
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);
    tokenManager.fetchVideoToken.mockClear();

    await vi.advanceTimersByTimeAsync(59_999);
    expect(tokenManager.fetchVideoToken).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tokenManager.fetchVideoToken).toHaveBeenCalledTimes(1);

    // Failure 3 → 120s backoff
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);
    tokenManager.fetchVideoToken.mockClear();

    await vi.advanceTimersByTimeAsync(119_999);
    expect(tokenManager.fetchVideoToken).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tokenManager.fetchVideoToken).toHaveBeenCalledTimes(1);
  });

  it('caps the ladder delay at 10 minutes on its last rung', async () => {
    await startWithCamera();
    const stream = getStream();
    stream.start.mockRejectedValue(new Error('camera offline'));

    // Failures 1-4 walk the ladder: 30s, 60s, 120s, 300s.
    for (const delay of [30_000, 60_000, 120_000, 300_000]) {
      tokenManager.emit('videoToken', 'cam-1', makeConfig());
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(delay);
    }

    // Failure 5 lands on the clamp. The circuit opens on failure 6, so this is
    // the only rung where the 10-minute cap is the delay actually used.
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);
    tokenManager.fetchVideoToken.mockClear();

    await vi.advanceTimersByTimeAsync(599_999);
    expect(tokenManager.fetchVideoToken).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tokenManager.fetchVideoToken).toHaveBeenCalledTimes(1);
  });

  it('resets backoff to 30s after a successful connection', async () => {
    await startWithCamera();
    const stream = getStream();

    // Fail twice to bump backoff
    stream.start.mockRejectedValue(new Error('camera offline'));
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000); // 1st failure → 30s

    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000); // 2nd failure → 60s

    // Now succeed
    stream.start.mockResolvedValue(undefined);
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);

    // Fail again — should be back to 30s, not 120s
    stream.start.mockRejectedValue(new Error('camera offline'));
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);
    tokenManager.fetchVideoToken.mockClear();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(tokenManager.fetchVideoToken).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tokenManager.fetchVideoToken).toHaveBeenCalledTimes(1);
  });

  it('recovers immediately when ffmpeg exits mid-stream', async () => {
    await startWithCamera();
    const stream = getStream();

    // Successful start — stream is active
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);
    tokenManager.fetchVideoToken.mockClear();

    // Simulate ffmpeg dying mid-stream
    stream.onUnexpectedExit();

    expect(tokenManager.fetchVideoToken).toHaveBeenCalledWith('cam-1');
  });

  it('does not recover on mid-stream exit after manager is stopped', async () => {
    await startWithCamera();
    const stream = getStream();

    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);

    await manager.stop();
    tokenManager.fetchVideoToken.mockClear();

    // Simulate ffmpeg dying after stop
    stream.onUnexpectedExit?.();

    expect(tokenManager.fetchVideoToken).not.toHaveBeenCalled();
  });

  it('uses reconnect instead of start when stream is already streaming', async () => {
    await startWithCamera();
    const stream = getStream();

    // First token → normal start
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);

    // Stream is now active
    stream.state = 'streaming';
    stream.start.mockClear();

    // Second token → should use reconnect
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);

    expect(stream.reconnect).toHaveBeenCalledOnce();
    expect(stream.start).not.toHaveBeenCalled();
  });

  it('falls back to start when reconnect fails', async () => {
    await startWithCamera();
    const stream = getStream();

    // First token → normal start
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);

    stream.state = 'streaming';
    stream.start.mockClear();
    stream.reconnect.mockRejectedValueOnce(new Error('reconnect failed'));

    // Second token → reconnect fails, should fall back to start
    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);

    expect(stream.reconnect).toHaveBeenCalledOnce();
    expect(stream.start).toHaveBeenCalledOnce();
  });

  it('uses start (not reconnect) when stream is in error state', async () => {
    await startWithCamera();
    const stream = getStream();

    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);

    stream.state = 'error';
    stream.start.mockClear();

    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);

    expect(stream.reconnect).not.toHaveBeenCalled();
    expect(stream.start).toHaveBeenCalledOnce();
  });

  describe('circuit breaker', () => {
    const LADDER_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
    const FIVE_MIN = 5 * 60_000;

    /** Make the stub behave like the real fetch: a usable token is emitted. */
    function autoEmitTokens() {
      tokenManager.fetchVideoToken.mockImplementation(async (id: string) => {
        const config = makeConfig();
        tokenManager.emit('videoToken', id, config);
        return config;
      });
    }

    /**
     * Walk the ladder to its end, which is six failures and opens the circuit,
     * then consume `probes` further probes on the escalating cooldown.
     */
    async function driveUntilOpen(probes = 0) {
      const cooldowns = [FIVE_MIN, 15 * 60_000, 30 * 60_000];
      tokenManager.emit('videoToken', 'cam-1', makeConfig());
      await vi.advanceTimersByTimeAsync(0);
      for (const delay of LADDER_MS) await vi.advanceTimersByTimeAsync(delay);
      for (let i = 0; i < probes; i++) await vi.advanceTimersByTimeAsync(cooldowns[i]);
    }

    it('opens once the ladder is exhausted and says so in the status line', async () => {
      autoEmitTokens();
      await startWithCamera();
      getStream().start.mockRejectedValue(new Error('camera offline'));

      await driveUntilOpen();

      expect(manager.getStatus()).toEqual({ driveway: 'idle (circuit open)' });
    });

    it('collapses the retry rate: 6 attempts/hour on the ladder, 3 once open', async () => {
      autoEmitTokens();
      await startWithCamera();
      const stream = getStream();
      stream.start.mockRejectedValue(new Error('camera offline'));

      await driveUntilOpen();
      stream.start.mockClear();

      await vi.advanceTimersByTimeAsync(60 * 60_000);

      // Probes at +5m, +20m, +50m. The saturated ladder would have retried
      // every 10 minutes, forever, and never stopped.
      expect(stream.start).toHaveBeenCalledTimes(3);
    });

    it('bounds the mid-stream recovery path, which has no backoff of its own', async () => {
      autoEmitTokens();
      await startWithCamera();
      const stream = getStream();
      stream.start.mockRejectedValue(new Error('camera offline'));

      await driveUntilOpen(1);
      stream.start.mockClear();

      // handleUnexpectedExit refetches immediately — no ladder, no delay. With
      // the next probe 15 minutes out, the circuit is the only thing stopping
      // a dying ffmpeg from hammering Alarm.com.
      stream.onUnexpectedExit();
      await vi.advanceTimersByTimeAsync(0);

      expect(stream.start).not.toHaveBeenCalled();
    });

    it('closes itself on the first successful probe, with no restart needed', async () => {
      autoEmitTokens();
      await startWithCamera();
      const stream = getStream();
      stream.start.mockRejectedValue(new Error('camera offline'));

      await driveUntilOpen();

      // The 2026-08-03 outage was cleared by power-cycling the camera. Nothing
      // restarted the bridge, so the circuit has to notice recovery by itself.
      stream.start.mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(FIVE_MIN);

      expect(manager.getStatus()).toEqual({ driveway: 'idle' });

      // And the fast ladder is available again from its first rung.
      stream.start.mockRejectedValue(new Error('camera offline'));
      tokenManager.emit('videoToken', 'cam-1', makeConfig());
      await vi.advanceTimersByTimeAsync(0);
      stream.start.mockClear();

      await vi.advanceTimersByTimeAsync(29_999);
      expect(stream.start).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(stream.start).toHaveBeenCalledTimes(1);
    });

    it('reports an open token circuit even when the stream circuit is closed', async () => {
      await startWithCamera();
      tokenManager.circuitState.mockReturnValue('open');

      expect(manager.getStatus()).toEqual({ driveway: 'idle (circuit open)' });
    });

    it('a failed overlap on a healthy stream is not a circuit-breaker failure', async () => {
      await startWithCamera();
      const stream = getStream();
      stream.state = 'streaming';
      // Overlap failed but the stream survived: reconnect() resolves.
      stream.reconnect.mockResolvedValue(undefined);

      for (let i = 0; i < 10; i++) {
        tokenManager.emit('videoToken', 'cam-1', makeConfig());
        await vi.advanceTimersByTimeAsync(0);
      }

      // Confirms the reconnect branch, not the start branch, ran ten times.
      expect(stream.reconnect).toHaveBeenCalledTimes(10);
      expect(stream.start).not.toHaveBeenCalled();
      // Ten "failures" recorded as breaker successes would have opened the
      // circuit at STREAM_FAILURE_THRESHOLD (6); it stays closed.
      expect(manager.getStatus()).toEqual({ driveway: 'streaming' });
    });

    it('getDiagnostics reports state, circuit and the last error', async () => {
      autoEmitTokens();
      await startWithCamera();
      const stream = getStream();
      stream.start.mockRejectedValue(new Error('camera offline'));

      await driveUntilOpen();

      const cam = manager.getDiagnostics().cameras.find((c) => c.name === 'driveway');
      expect(cam).toBeDefined();
      expect(cam!.streamCircuit).toBe('open');
      expect(cam!.lastError).toContain('camera offline');
      expect(cam!.streamFailures).toBeGreaterThan(0);
      expect(typeof cam!.streamNextProbeInMs).toBe('number');
    });

    it("reports each breaker's OWN failure count and cooldown", async () => {
      // Measured in production 2026-08-06: the payload showed
      // `tokenCircuit: open` beside `nextProbeInMs: 0`. That 0 came from the
      // STREAM breaker — closed and idle because no tokens ever arrive — while
      // the breaker actually blocking was the token one, whose cooldown was not
      // in the payload at all. It reads as "paused, probing right now" when the
      // next token probe can be an hour away, and it is most misleading in
      // exactly the state where an operator asks "when does it retry?".
      await startWithCamera();
      tokenManager.circuitState.mockReturnValue('open');
      tokenManager.circuitFailures.mockReturnValue(3);
      tokenManager.circuitRetryAfterMs.mockReturnValue(1_800_000);

      const cam = manager.getDiagnostics().cameras.find((c) => c.name === 'driveway');

      expect(cam!.tokenCircuit).toBe('open');
      expect(cam!.tokenFailures).toBe(3);
      expect(cam!.tokenNextProbeInMs).toBe(1_800_000);
      // The stream breaker is closed and idle here; its numbers stay its own
      // and must not be reported as if they described the open circuit.
      expect(cam!.streamCircuit).toBe('closed');
      expect(cam!.streamFailures).toBe(0);
      expect(cam!.streamNextProbeInMs).toBe(0);
    });

    // The endpoint serves this over the network, and camera IDs are treated as
    // sensitive throughout this project.
    it('getDiagnostics carries camera NAMES only, never IDs', async () => {
      await startWithCamera();

      const json = JSON.stringify(manager.getDiagnostics());

      expect(json).toContain('driveway');
      expect(json).not.toContain('cam-1');
    });

    it('does not credit a torn-down stream when reconnect() resolves after it', async () => {
      autoEmitTokens();
      await startWithCamera();
      const stream = getStream();
      stream.start.mockRejectedValue(new Error('camera offline'));

      // Open the circuit the normal way, through real failures.
      await driveUntilOpen();
      expect(manager.getStatus()).toEqual({ driveway: 'idle (circuit open)' });

      // Now the stream is streaming and gets a reconnect() that resolves —
      // but only because something else (a concurrent recovery, a
      // mid-overlap death) tore it down while it was in flight, leaving
      // state at 'error' by the time it returns. A false credit here would
      // close the circuit on a stream that never actually recovered.
      stream.state = 'streaming';
      stream.reconnect.mockImplementation(async () => {
        stream.state = 'error';
      });

      // driveUntilOpen()'s final failure leaves a probe timer pending (the
      // guard is only released when it fires); let it fire — that's what
      // calls fetchVideoToken() and re-enters handleVideoToken, which takes
      // the reconnect branch since the stream is (nominally) streaming.
      await vi.advanceTimersByTimeAsync(FIVE_MIN);

      expect(stream.reconnect).toHaveBeenCalledOnce();
      expect(manager.getStatus()).toEqual({ driveway: 'error (circuit open)' });
    });

    it('credits a recovery that fell back to a full restart before onTrackReady', async () => {
      autoEmitTokens();
      await startWithCamera();
      const stream = getStream();
      stream.start.mockRejectedValue(new Error('camera offline'));

      await driveUntilOpen();
      expect(manager.getStatus()).toEqual({ driveway: 'idle (circuit open)' });

      // The active session died mid-overlap, so reconnect() fell back to
      // break-before-make. That path awaits tryConnect(), which resolves on
      // PeerSession.connect() -> 'sessionStarted' — while _state is still
      // 'connecting', because only onTrackReady (first RTP) flips it to
      // 'streaming'. This is a REAL recovery, and it must reset the breaker;
      // requiring 'streaming' here records neither success nor failure, so
      // six such fallbacks with no clean cutover between would leave the
      // counters uncleared.
      stream.state = 'streaming';
      stream.reconnect.mockImplementation(async () => {
        stream.state = 'connecting';
      });

      await vi.advanceTimersByTimeAsync(FIVE_MIN);

      expect(stream.reconnect).toHaveBeenCalledOnce();
      // Credited: the '(circuit open)' suffix is gone.
      expect(manager.getStatus()).toEqual({ driveway: 'connecting' });
    });

    it('does not let a stale reconnect() completion clear a newer start\'s guard', async () => {
      autoEmitTokens();
      await startWithCamera();
      const stream = getStream();
      stream.state = 'streaming';

      // A: seamless reconnect, parked mid-negotiation.
      let resolveReconnect!: () => void;
      stream.reconnect.mockImplementation(
        () => new Promise<void>((resolve) => { resolveReconnect = resolve; }),
      );

      tokenManager.emit('videoToken', 'cam-1', makeConfig());
      await vi.advanceTimersByTimeAsync(0);
      expect(stream.reconnect).toHaveBeenCalledOnce();

      // ffmpeg dies mid-overlap. The real handleUnexpectedExit() clears the
      // guard unconditionally and fetches a fresh token, which — per
      // autoEmitTokens() — immediately re-enters as a new videoToken event.
      stream.state = 'error';
      let resolveStart!: () => void;
      stream.start.mockImplementation(
        () => new Promise<void>((resolve) => { resolveStart = resolve; }),
      );
      stream.onUnexpectedExit();
      await vi.advanceTimersByTimeAsync(0);

      // B is now mid-start (parked, dial-in retries can take minutes). A's
      // stale reconnect() is still pending too.
      expect(stream.start).toHaveBeenCalledOnce();

      // A's stale reconnect() now completes.
      resolveReconnect();
      await vi.advanceTimersByTimeAsync(0);

      // A's completion must not have cleared B's guard: a token event
      // arriving in this window must be skipped, not start a second
      // concurrent stream.start() — which would race B's own tryConnect()
      // for ownership of ffmpeg/socket/`this.active`.
      tokenManager.emit('videoToken', 'cam-1', makeConfig());
      await vi.advanceTimersByTimeAsync(0);
      expect(stream.start).toHaveBeenCalledOnce();

      resolveStart();
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  it('does not retry when manager is stopped', async () => {
    await startWithCamera();
    const stream = getStream();
    stream.start.mockRejectedValue(new Error('camera offline'));

    tokenManager.emit('videoToken', 'cam-1', makeConfig());
    await vi.advanceTimersByTimeAsync(0);

    await manager.stop();
    tokenManager.fetchVideoToken.mockClear();

    await vi.advanceTimersByTimeAsync(600_000);
    expect(tokenManager.fetchVideoToken).not.toHaveBeenCalled();
  });
});
