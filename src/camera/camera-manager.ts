import { createChildLogger } from '../utils/logger.js';
import { TokenManager } from '../auth/token-manager.js';
import { CircuitBreaker } from '../utils/circuit-breaker.js';
import { CameraStream } from './camera-stream.js';
import type { CameraConfig } from '../config.js';
import type { EndToEndWebrtcConfig } from '../types.js';

const log = createChildLogger('camera-manager');

const BACKOFF_STEPS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
/**
 * One failure per rung plus one: the ladder is walked to its 10-minute cap and
 * applied once before the circuit opens, ~18 minutes into a camera that will
 * not start. This is the least urgent of the three loops — its own cap already
 * bounds it to ~6 attempts/hour, and a failure here often means one sick camera
 * rather than an Alarm.com outage.
 */
export const STREAM_FAILURE_THRESHOLD = BACKOFF_STEPS_MS.length + 1;

/**
 * Orchestrates multiple camera stream pipelines.
 * Subscribes to TokenManager events to start/restart streams on token refresh.
 */
export class CameraManager {
  private streams = new Map<string, CameraStream>();
  // Guards against a second concurrent start/reconnect per camera. Maps to
  // the id of the attempt currently holding the guard (see startSeq) rather
  // than a bare presence flag, so a stale completion can release only the
  // attempt it actually owns — never a newer one that has since taken over.
  private activeStarts = new Map<string, number>();
  private startSeq = 0;
  private failureCount = new Map<string, number>();
  private lastError = new Map<string, { message: string; at: number }>();
  private breakers = new Map<string, CircuitBreaker>();
  private running = false;

  constructor(
    private readonly tokenManager: TokenManager,
    private readonly rtspBaseUrl: string,
  ) {}

  async start(cameras: CameraConfig[]): Promise<void> {
    if (cameras.length === 0) {
      throw new Error(
        'No cameras configured. Run "npx tsx src/discover.ts" to find your camera IDs, ' +
        'then add them to config/config.yaml and config/go2rtc.yaml.',
      );
    }

    this.running = true;

    for (const cam of cameras) {
      const stream = new CameraStream(cam.id, cam.name, this.rtspBaseUrl);
      stream.onUnexpectedExit = () => this.handleUnexpectedExit(cam.id);
      this.streams.set(cam.id, stream);
    }

    this.tokenManager.on('videoToken', (cameraId, config) => {
      this.handleVideoToken(cameraId, config);
    });

    this.tokenManager.on('error', (cameraId, error) => {
      log.error({ cameraId }, 'Token error: %s', error.message);
    });

    const cameraIds = cameras.map((c) => c.id);
    await this.tokenManager.start(cameraIds);

    log.info({ cameras: cameras.map((c) => c.name) }, 'Camera manager started');
  }

  async stop(): Promise<void> {
    this.running = false;
    this.tokenManager.stop();

    const stopPromises = Array.from(this.streams.values()).map((stream) => stream.stop());
    await Promise.allSettled(stopPromises);
    this.streams.clear();

    log.info('Camera manager stopped');
  }

  getStatus(): Record<string, string> {
    const status: Record<string, string> = {};
    for (const [id, stream] of this.streams) {
      // Surface a paused loop in the periodic status line, so an operator
      // reading the logs sees why an idle camera is not being retried.
      const paused =
        this.breakers.get(id)?.state === 'open' || this.tokenManager.circuitState(id) === 'open';
      status[stream.cameraName] = paused ? `${stream.state} (circuit open)` : stream.state;
    }
    return status;
  }

  /**
   * Operational snapshot for the status endpoint.
   *
   * 🔴 Deliberately carries camera NAMES only, never camera IDs — the IDs are
   * treated as sensitive throughout this project and this data is served over
   * the network.
   */
  getDiagnostics(): {
    running: boolean;
    cameras: Array<{
      name: string;
      state: string;
      streamCircuit: string;
      tokenCircuit: string;
      consecutiveFailures: number;
      nextProbeInMs: number;
      lastError?: string;
      lastErrorAgoMs?: number;
    }>;
  } {
    const cameras = [];
    for (const [id, stream] of this.streams) {
      const breaker = this.breakers.get(id);
      const err = this.lastError.get(id);
      cameras.push({
        name: stream.cameraName,
        state: stream.state,
        streamCircuit: breaker?.state ?? 'closed',
        tokenCircuit: this.tokenManager.circuitState(id),
        consecutiveFailures: breaker?.consecutiveFailures ?? 0,
        nextProbeInMs: breaker?.retryAfterMs() ?? 0,
        ...(err ? { lastError: err.message, lastErrorAgoMs: Date.now() - err.at } : {}),
      });
    }
    return { running: this.running, cameras };
  }

  private async handleVideoToken(cameraId: string, config: EndToEndWebrtcConfig): Promise<void> {
    const stream = this.streams.get(cameraId);
    if (!stream) {
      log.warn({ cameraId }, 'Received token for unknown camera');
      return;
    }

    // Skip if a start is already in progress (e.g., dial-in retry loop)
    if (this.activeStarts.has(cameraId)) {
      log.debug({ camera: stream.cameraName }, 'Start already in progress, skipping token event');
      return;
    }

    const breaker = this.breakerFor(cameraId);

    // If the stream is already active, do a seamless reconnect (keeps ffmpeg alive)
    if (stream.state === 'streaming') {
      const startId = ++this.startSeq;
      this.activeStarts.set(cameraId, startId);
      try {
        log.info({ camera: stream.cameraName }, 'Seamless reconnect with fresh token');
        await stream.reconnect(config);
        // reconnect() can resolve well after something else (a concurrent
        // recovery, a mid-overlap death) has already torn this stream down —
        // crediting that as a success would hide a real failure from the
        // breaker. Two independent things have to hold, and neither implies
        // the other:
        //   - We still own the guard. A stale attempt whose guard was taken
        //     over (handleUnexpectedExit -> a fresh start) is crediting a
        //     recovery that is not its own.
        //   - The stream is not dead. An attempt can still own the guard and
        //     yet have had its stream torn down while it was in flight.
        // 'connecting' counts as alive, and deliberately so: the activeDied
        // fallback awaits tryConnect(), which resolves on 'sessionStarted'
        // while _state is still 'connecting' — only onTrackReady (first RTP)
        // flips it to 'streaming'. Demanding 'streaming' here would record
        // neither success nor failure on a genuine recovery, leaving
        // failureCount and the breaker uncleared. Unknown/dead states default
        // to no credit: a missed credit is bounded, a false one hides an outage.
        const stillOurs = this.activeStarts.get(cameraId) === startId;
        const alive = stream.state === 'streaming' || stream.state === 'connecting';
        if (stillOurs && alive) {
          this.failureCount.delete(cameraId);
          breaker.recordSuccess();
        }
        this.releaseStart(cameraId, startId);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ camera: stream.cameraName }, 'Reconnect failed (%s), falling back to full restart', msg);
        this.releaseStart(cameraId, startId);
      }
    }

    // A token can arrive from the 600s refresh timer as well as from the retry
    // ladder below, so the ladder's delay alone does not bound how often a
    // hopeless start is attempted. The circuit does.
    if (!breaker.tryAttempt()) {
      log.debug({ camera: stream.cameraName }, 'Stream start suppressed — circuit open');
      return;
    }

    const startId = ++this.startSeq;
    this.activeStarts.set(cameraId, startId);

    try {
      log.info({ camera: stream.cameraName }, 'Starting stream with fresh token');

      // Silent fetch so dial-in retries don't trigger another handleVideoToken
      const refetchToken = async () => this.tokenManager.fetchVideoTokenSilent(cameraId);
      await stream.start(config, refetchToken);

      this.failureCount.delete(cameraId);
      breaker.recordSuccess();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ camera: stream.cameraName }, 'Stream failed after all retries: %s', msg);
      this.lastError.set(cameraId, { message: msg, at: Date.now() });
      breaker.recordFailure(msg);

      if (this.running) {
        const failures = this.failureCount.get(cameraId) ?? 0;
        const delay =
          breaker.state === 'open'
            ? breaker.retryAfterMs()
            : BACKOFF_STEPS_MS[Math.min(failures, BACKOFF_STEPS_MS.length - 1)];
        this.failureCount.set(cameraId, failures + 1);

        log.info({ camera: stream.cameraName, delay: delay / 1000, failures: failures + 1 }, 'Will retry in %ds', delay / 1000);
        setTimeout(() => {
          this.releaseStart(cameraId, startId);
          if (!this.running) return;
          this.tokenManager.fetchVideoToken(cameraId);
        }, delay);
        return;
      }
    }

    this.releaseStart(cameraId, startId);
  }

  /**
   * Clear the start guard, but only if it still belongs to this attempt.
   * A completion that runs after a newer attempt has already taken the
   * guard (e.g. a stale reconnect() resolving after handleUnexpectedExit()
   * has already handed off to a fresh start()) must not clear that newer
   * attempt's guard out from under it.
   */
  private releaseStart(cameraId: string, startId: number): void {
    if (this.activeStarts.get(cameraId) === startId) {
      this.activeStarts.delete(cameraId);
    }
  }

  private breakerFor(cameraId: string): CircuitBreaker {
    let breaker = this.breakers.get(cameraId);
    if (!breaker) {
      breaker = new CircuitBreaker({
        label: `stream:${cameraId}`,
        failureThreshold: STREAM_FAILURE_THRESHOLD,
      });
      this.breakers.set(cameraId, breaker);
    }
    return breaker;
  }

  private handleUnexpectedExit(cameraId: string): void {
    if (!this.running) return;

    const stream = this.streams.get(cameraId);
    const name = stream?.cameraName ?? cameraId;
    log.warn({ camera: name }, 'Stream died mid-stream, fetching fresh token to recover');

    // Unconditional, not releaseStart(): this fires from an external event
    // (ffmpeg exit) that owns no startId of its own, and it deliberately
    // wants the guard open regardless of who currently holds it, so recovery
    // can start immediately rather than waiting for a stale attempt's own
    // completion. That stale attempt's own eventual releaseStart() is what's
    // ownership-scoped — it will find a newer startId here (the one the
    // fetchVideoToken call below leads to) and correctly leave it alone.
    this.activeStarts.delete(cameraId);
    this.tokenManager.fetchVideoToken(cameraId);
  }
}
