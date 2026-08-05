import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket, type Socket } from 'node:dgram';
import { createChildLogger } from '../utils/logger.js';
import { sleep } from '../utils/retry.js';
import { PeerSession, type PeerSessionCallbacks } from './peer-session.js';
import type { EndToEndWebrtcConfig } from '../types.js';

const log = createChildLogger('camera-stream');

const MAX_DIAL_IN_RETRIES = 12;
const DIAL_IN_RETRY_DELAY_MS = 10_000;
const INITIAL_WAKE_DELAY_MS = 5_000;

// How long a pending overlap session may negotiate before it is given up on.
// The old token has no server-enforced timeout, so giving up costs nothing —
// the next 600s refresh just tries again.
export const OVERLAP_BUDGET_MS = 10_000;

export type StreamState = 'idle' | 'connecting' | 'streaming' | 'error';

export type TokenFetcher = () => Promise<EndToEndWebrtcConfig | null>;

/** How an overlap between the active and pending sessions was resolved. */
export type OverlapOutcome = 'cutover' | 'kept' | 'fallback';

/**
 * Manages a single camera's WebRTC-to-RTSP pipeline:
 * ADC signaling → werift PeerConnection → RTP → ffmpeg → RTSP push to go2rtc
 */
export class CameraStream {
  private active: PeerSession | null = null;
  // The overlapping "make before break" session being negotiated during a
  // reconnect. RTP from it is never forwarded — see handleRtp's gate — until
  // its first packet proves media flows and cutOver() promotes it to active.
  private pending: PeerSession | null = null;
  // Bounds how long an overlap may run — armed by reconnect(), cleared by
  // cutOver(), discardPending(), and stop().
  private overlapTimer: ReturnType<typeof setTimeout> | null = null;
  // The resolver for reconnect()'s outcome promise; assigned while an overlap
  // is in flight, null once settled.
  private overlapSettle: ((outcome: OverlapOutcome) => void) | null = null;
  // Set by handleSessionFailed() when the active session dies mid-overlap;
  // consulted once the overlap settles and reset both before a new overlap
  // starts and once consumed, so a stale flag can never force a spurious
  // fallback on a later, healthy reconnect.
  private activeDied = false;
  private ffmpeg: ChildProcess | null = null;
  private videoSocket: Socket | null = null;
  private videoPort = 0;
  private rtpCount = 0;
  private _state: StreamState = 'idle';

  /** Called when ffmpeg exits unexpectedly while the stream was active. */
  onUnexpectedExit: (() => void) | null = null;

  private readonly sessionCallbacks: PeerSessionCallbacks = {
    onRtp: (session, packet) => this.handleRtp(session, packet),
    onTrackReady: (session) => {
      // A session that is neither active nor pending has already been
      // discarded (stop(), a superseding reconnect, ...). A late callback
      // from it must not spawn an unowned ffmpeg with nothing left to feed
      // it, or open a videoSocket for a pipeline that no longer exists.
      if (session !== this.active && session !== this.pending) return;
      this.startFfmpeg(session);
      if (!this.videoSocket) this.videoSocket = createSocket('udp4');
      if (session === this.active) this._state = 'streaming';
    },
    onFailed: (session) => this.handleSessionFailed(session),
  };

  constructor(
    readonly cameraId: string,
    readonly cameraName: string,
    private readonly rtspBaseUrl: string,
  ) {}

  get state(): StreamState {
    return this._state;
  }

  /**
   * Start the stream pipeline.
   *
   * Strategy (matches the HA integration's behavior):
   * 1. The initial token fetch (already done) wakes the camera on ADC's backend
   * 2. Try connecting — if camera hasn't dialed in, wait and fetch a FRESH token
   * 3. The fresh token creates a new signaling room that the now-awake camera can join
   */
  async start(config: EndToEndWebrtcConfig, refetchToken?: TokenFetcher): Promise<void> {
    let currentConfig = config;

    for (let attempt = 1; attempt <= MAX_DIAL_IN_RETRIES; attempt++) {
      try {
        await this.tryConnect(currentConfig);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isDialInError = message.includes('not yet dialed in');

        if (isDialInError && attempt < MAX_DIAL_IN_RETRIES) {
          // Wait longer on early attempts (camera may still be booting)
          const delay = attempt <= 2 ? 15_000 : DIAL_IN_RETRY_DELAY_MS;
          log.info(
            { camera: this.cameraName, attempt, maxAttempts: MAX_DIAL_IN_RETRIES },
            'Camera not yet dialed in, waiting %ds then fetching fresh token...',
            delay / 1000,
          );
          await this.stop();
          await sleep(delay);

          // Fetch a FRESH token — the camera should now be awake and will
          // dial in to this new signaling room
          if (refetchToken) {
            const fresh = await refetchToken();
            if (fresh) currentConfig = fresh;
          }
          continue;
        }

        this._state = 'error';
        throw err;
      }
    }

    this._state = 'error';
    throw new Error(`Camera ${this.cameraName} failed to dial in after ${MAX_DIAL_IN_RETRIES} attempts`);
  }

  /**
   * Reconnect WebRTC with a fresh token while keeping ffmpeg and the UDP
   * socket alive. The old session is left running and keeps feeding ffmpeg
   * while the new one negotiates in parallel — state stays 'streaming' for
   * the whole overlap, since media never stops. cutOver() (triggered by the
   * new session's first RTP packet, in handleRtp) is what actually retires
   * the old session; this method arms the overlap and resolves only once its
   * outcome is known.
   *
   * Resolves once the overlap is settled, never on negotiation alone —
   * CameraManager records breaker.recordSuccess() when this resolves, which
   * would be wrong for an overlap that never actually completed. A pending
   * session that fails or times out still resolves (not throws): the old
   * session is still streaming, so a failed overlap costs nothing.
   */
  async reconnect(config: EndToEndWebrtcConfig): Promise<void> {
    if (this._state !== 'streaming') {
      throw new Error(`Cannot reconnect: expected 'streaming', got '${this._state}'`);
    }

    log.info({ camera: this.cameraName }, 'Reconnecting WebRTC (old session stays live during overlap)...');

    // A flag left over from a previous overlap must never leak into this
    // one — only this overlap's own handleSessionFailed() may set it below.
    // Reset BEFORE the discardPending() await, not after: discardPending()
    // awaits a genuine I/O close(), and the active session can die inside
    // that window (via handleSessionFailed, setting this flag true). Reset
    // it after the await instead and that death is wiped the instant it's
    // recorded, so a dead active session gets reported as a success.
    this.activeDied = false;

    // Never depend on a caller's bookkeeping to avoid leaking a session — a
    // stale pending from an earlier reconnect must not survive into this one.
    await this.discardPending('superseded by a newer reconnect');

    const outcome = new Promise<OverlapOutcome>((resolve) => {
      this.overlapSettle = resolve;
      this.overlapTimer = setTimeout(() => {
        void this.discardPending('no RTP within the overlap budget');
      }, OVERLAP_BUDGET_MS);
    });

    try {
      await this.negotiatePending(config);
      log.info({ camera: this.cameraName }, 'Pending session connected, waiting for first RTP to cut over...');
    } catch (err) {
      // negotiatePending() already discarded the session that failed; this
      // just clears the budget timer and settles the outcome (discardPending
      // settles internally now — see its own comment).
      const msg = err instanceof Error ? err.message : String(err);
      // A rejected pending while active is healthy is the signature of "ADC
      // permits only one session per camera" — the question we cannot test
      // until the camera's WiFi is fixed. Log distinctly so production
      // answers it: if this repeats every refresh, we have our answer. But
      // only when it plausibly IS a refusal: the active session dying
      // mid-overlap, or a stop() tearing the pending down from under it,
      // rejects negotiatePending() too, and neither is evidence of anything
      // ADC did — logging those at the same level would pollute the one
      // signal this line exists to give production.
      if (this._state === 'streaming' && !this.activeDied) {
        log.warn(
          { camera: this.cameraName, reason: msg },
          'Second concurrent session refused by Alarm.com — keeping the current one. ' +
          'If this repeats every refresh, ADC permits only one session per camera and ' +
          'make-before-break is not achievable (see Omar-L#25).',
        );
      } else {
        log.debug(
          { camera: this.cameraName, reason: msg },
          'Pending negotiation ended without completing (active session unhealthy or stream stopped, not a refusal)',
        );
      }
      await this.discardPending(msg);
    }

    const result = await outcome;
    if (result === 'kept' && !this.activeDied) {
      log.info({ camera: this.cameraName }, 'Overlap did not complete; keeping the current session');
      return;
    }
    if (result === 'kept' && this.activeDied) {
      // The old session died during the overlap, so there is nothing left to
      // protect. handleSessionFailed() has already discarded pending, so the
      // fallback below is never racing a still-live overlap session. Fall
      // back to today's break-before-make and let it report.
      this.activeDied = false;
      log.warn({ camera: this.cameraName }, 'Active session died mid-overlap; falling back to a full reconnect');
      await this.tryConnect(config);
    }
    // Otherwise result === 'cutover': cutOver() already logged and handled
    // everything, and activeDied cannot be true here (cutOver's own
    // _state === 'streaming' guard means the two never coincide).
  }

  /** Tear down the entire pipeline. */
  async stop(): Promise<void> {
    // discardPending() nulls this.pending synchronously, before its own
    // close() await. An abandoned pending session is not inert — its first
    // RTP still reaches cutOver via handleRtp's identity check — so it must
    // be detached up front, not after the active-session teardown below has
    // already had a chance to yield.
    await this.discardPending('stream stopped');

    await this.active?.close();
    this.active = null;

    if (this.ffmpeg) {
      // Detach ownership before signaling the child. The exit event may be
      // delivered after a replacement ffmpeg has already started; that stale
      // event must not clear the replacement or trigger stream recovery.
      const ffmpeg = this.ffmpeg;
      this.ffmpeg = null;
      ffmpeg.kill('SIGTERM');
    }

    if (this.videoSocket) {
      this.videoSocket.close();
      this.videoSocket = null;
    }

    this.rtpCount = 0;
    this._state = 'idle';
    log.info({ camera: this.cameraName }, 'Stream stopped');
  }

  private buildFmtp(h264Fmtp: string | null): string {
    if (!h264Fmtp) return 'packetization-mode=1';
    if (h264Fmtp.includes('packetization-mode')) return h264Fmtp;
    return `packetization-mode=1;${h264Fmtp}`;
  }

  private async tryConnect(config: EndToEndWebrtcConfig): Promise<void> {
    await this.stop();
    // Belt-and-suspenders: stop() already discards pending, but this method
    // is about to install a brand-new active session, and a stale pending
    // surviving to this point must not be left to race and replace it via
    // cutOver.
    await this.discardPending('superseded by a new active session');
    this._state = 'connecting';

    this.videoPort = await this.allocateUdpPort();
    log.info({ camera: this.cameraName, videoPort: this.videoPort }, 'Allocated RTP port');

    const session = new PeerSession(this.cameraName, this.sessionCallbacks);
    this.active = session;
    await session.connect(config);
  }

  /** Forward RTP from the active session to ffmpeg over the loopback UDP socket. */
  private handleRtp(session: PeerSession, packet: Buffer): void {
    // The first packet from pending is the proof that media flows on the new
    // session. Cut over here, then forward this same packet — nothing is lost.
    if (session === this.pending) this.cutOver(session);
    if (session !== this.active) return;
    if (!this.videoSocket || !this.videoPort) return;

    this.videoSocket.send(packet, this.videoPort, '127.0.0.1');
    this.rtpCount++;
    if (this.rtpCount === 1 || this.rtpCount === 100) {
      log.info({ camera: this.cameraName, rtpCount: this.rtpCount, bytes: packet.length }, 'RTP packets sent to ffmpeg');
    } else if (this.rtpCount % 1000 === 0) {
      log.debug({ camera: this.cameraName, rtpCount: this.rtpCount, bytes: packet.length }, 'RTP packets sent to ffmpeg');
    }
  }

  /** Promote pending to active now that it has proven media flows. */
  private cutOver(session: PeerSession): void {
    if (this._state !== 'streaming') {
      // The pipeline was torn down (or the active session already failed)
      // while this session was negotiating in the background. Its first RTP
      // must not resurrect a stream that's no longer there to receive it —
      // release it instead of promoting it.
      if (this.pending === session) this.pending = null;
      void session.close().catch(() => {});
      return;
    }

    const previous = this.active;
    this.active = session;
    this.pending = null;
    this.clearOverlapTimer();
    this._state = 'streaming';
    log.info(
      { camera: this.cameraName, from: previous?.id, to: session.id },
      'Cut over to the new session without a media gap',
    );
    void previous?.close().catch(() => {});
    this.settleOverlap('cutover');
  }

  /**
   * Detach and close any in-flight pending overlap session, clear the
   * overlap budget timer, and settle the outcome — the three always end
   * together. This is the only path that ends an overlap from OUTSIDE
   * reconnect() (stop(), tryConnect(), a superseding reconnect()), so it
   * must never leave reconnect()'s `await outcome` unresolved: settling here
   * (rather than leaving it to the timeout/cutover/catch alone) is what
   * guarantees reconnect() always returns. settleOverlap() is idempotent, so
   * this is harmless when nothing was awaiting an outcome. Idempotent
   * overall: safe to call with no pending in flight.
   */
  private async discardPending(reason: string): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    this.clearOverlapTimer();
    this.settleOverlap('kept');
    if (!pending) return;
    log.warn({ camera: this.cameraName, session: pending.id, reason }, 'Discarding pending session');
    await pending.close().catch(() => {});
  }

  /** Resolve whoever is awaiting the current overlap. No-op once already settled. */
  private settleOverlap(outcome: OverlapOutcome): void {
    const settle = this.overlapSettle;
    this.overlapSettle = null;
    settle?.(outcome);
  }

  /** Clear the overlap budget timer, if armed. Idempotent. */
  private clearOverlapTimer(): void {
    if (this.overlapTimer) {
      clearTimeout(this.overlapTimer);
      this.overlapTimer = null;
    }
  }

  /** Build a PeerSession for `config` and await SESSION_STARTED. Rejects if ADC refuses. */
  private async negotiatePending(config: EndToEndWebrtcConfig): Promise<void> {
    const session = new PeerSession(this.cameraName, this.sessionCallbacks);
    this.pending = session;

    try {
      await session.connect(config);
    } catch (err) {
      // connect() does not clean up after itself on rejection — it leaves
      // the RTCPeerConnection and signaling WebSocket live. Nothing else
      // owns this session, so a leak here is silent and per-reconnect.
      if (this.pending === session) this.pending = null;
      // A late rejection can race a cutover that already promoted this same
      // session to active — its first RTP packet can arrive before
      // connect()'s own promise settles. Closing it here would tear down
      // the stream that reconnect() is about to report as a cutover.
      if (this.active !== session) await session.close().catch(() => {});
      throw err;
    }
  }

  private handleSessionFailed(session: PeerSession): void {
    if (session === this.pending) {
      // Dead weight — left alone it would just sit until the overlap budget
      // expires with no chance of ever cutting over.
      void this.discardPending('peer connection failed');
      return;
    }
    if (session !== this.active) return;

    this.activeDied = true; // consulted once the overlap settles, in reconnect()
    this._state = 'error';
    // cutOver() already refuses to promote once _state !== 'streaming', so
    // any in-flight pending negotiation can never complete anyway. Discard
    // it now — settling the overlap immediately — rather than leaving
    // reconnect() parked for the rest of the 10s budget before it can fall
    // back.
    void this.discardPending('active session died mid-overlap');
  }

  private startFfmpeg(session: PeerSession): void {
    if (this.ffmpeg) return;

    const rtspUrl = `${this.rtspBaseUrl}/${this.cameraName}`;

    // ffmpeg needs an SDP descriptor to know the codec format of the RTP stream
    const sdp = [
      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=ADC Camera',
      'c=IN IP4 127.0.0.1',
      't=0 0',
      `m=video ${this.videoPort} RTP/AVP 96`,
      'a=rtpmap:96 H264/90000',
      `a=fmtp:96 ${this.buildFmtp(session.h264Fmtp)}`,
    ].join('\r\n') + '\r\n';

    const args = [
      '-hide_banner',
      '-loglevel', 'info',
      // Give ffmpeg enough time to receive an IDR frame with SPS/PPS
      '-analyzeduration', '10000000',
      '-probesize', '32000000',
      '-fflags', '+genpts+discardcorrupt',
      '-reorder_queue_size', '0',
      // Read SDP from stdin to know what format the RTP is
      '-protocol_whitelist', 'file,udp,rtp,pipe',
      '-f', 'sdp',
      '-i', 'pipe:0',
      // Output: passthrough to RTSP
      '-c:v', 'copy',
      '-bsf:v', 'dump_extra',
      '-f', 'rtsp',
      '-rtsp_transport', 'tcp',
      rtspUrl,
    ];

    log.info({ camera: this.cameraName, rtspUrl }, 'Starting ffmpeg');
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.ffmpeg = ffmpeg;

    // Write the SDP to ffmpeg's stdin, then close it
    ffmpeg.stdin?.write(sdp);
    ffmpeg.stdin?.end();

    ffmpeg.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (!line) return;
      // ffmpeg progress lines are noisy once streaming is established
      const isProgress = line.startsWith('frame=') || line.startsWith('size=');
      if (isProgress) {
        log.debug({ camera: this.cameraName, ffmpeg: line }, 'ffmpeg');
      } else {
        log.info({ camera: this.cameraName, ffmpeg: line }, 'ffmpeg');
      }
    });

    ffmpeg.on('exit', (code) => {
      // Ignore an intentionally stopped or superseded child. Without this
      // identity check, a late exit from the old process can erase the
      // current process reference and restart an otherwise healthy stream.
      if (this.ffmpeg !== ffmpeg) {
        log.debug({ camera: this.cameraName, code }, 'Ignoring stale ffmpeg exit');
        return;
      }

      log.warn({ camera: this.cameraName, code }, 'ffmpeg exited');
      this.ffmpeg = null;

      if (this._state === 'streaming') {
        this._state = 'error';
        log.error({ camera: this.cameraName, code }, 'ffmpeg exited unexpectedly while streaming');
        this.onUnexpectedExit?.();
      }
    });
  }

  /** Allocate a random available UDP port by briefly binding then releasing. */
  private allocateUdpPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const sock = createSocket('udp4');
      sock.bind(0, '127.0.0.1', () => {
        const port = sock.address().port;
        sock.close(() => resolve(port));
      });
      sock.on('error', reject);
    });
  }
}
