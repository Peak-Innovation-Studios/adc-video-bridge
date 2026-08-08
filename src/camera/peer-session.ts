import { RTCPeerConnection, RTCRtpCodecParameters } from 'werift';
import { SignalingClient } from '../signaling/signaling-client.js';
import { createChildLogger } from '../utils/logger.js';
import { parseH264Fmtp } from '../utils/sdp.js';
import type { EndToEndWebrtcConfig, RTCSessionDescriptionLike, RTCIceCandidateLike } from '../types.js';

const log = createChildLogger('peer-session');

/**
 * How long ICE may sit in 'disconnected' before it is treated as failed.
 *
 * ⚠️ **This value is NOT measured.** It is chosen from how ICE behaves
 * generally — a recoverable blip settles in a few seconds — not from
 * observation of these cameras, which now run on local RTSP where this code
 * does not execute. It is a named constant precisely so it can be tuned by
 * someone who can watch a real WebRTC session.
 *
 * 🔑 The important part is not the number. Any grace period at all is correct
 * where zero is not: 'disconnected' is recoverable by definition, and a
 * teardown costs a fresh video token plus a full renegotiation.
 */
const ICE_DISCONNECT_GRACE_MS = 8_000;

let nextSessionId = 1;

export interface PeerSessionCallbacks {
  onRtp: (session: PeerSession, packet: Buffer) => void;
  /** Fired once, when this session's video track is subscribed — before any RTP. */
  onTrackReady?: (session: PeerSession) => void;
  onFailed?: (session: PeerSession) => void;
}

/**
 * One ADC signaling room + WebRTC PeerConnection: the control-plane half of
 * a camera connection. Owns nothing about ffmpeg or the RTSP output — it
 * just hands decoded RTP packets to its callbacks.
 */
export class PeerSession {
  readonly id: number;
  readonly signaling: SignalingClient;
  h264Fmtp: string | null = null;

  private pc: RTCPeerConnection | null = null;
  private closed = false;
  /** Armed while ICE is 'disconnected'; see the connectionStateChange handler. */
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private rtpSubscribed = false;

  constructor(
    private readonly cameraName: string,
    private readonly callbacks: PeerSessionCallbacks,
  ) {
    this.id = nextSessionId++;
    this.signaling = new SignalingClient(cameraName);
  }

  /** Connect signaling and the peer connection. Resolves on SESSION_STARTED. */
  async connect(config: EndToEndWebrtcConfig): Promise<void> {
    this.pc = this.createPeerConnection(config);
    this.setupPeerConnection();
    await this.connectSignaling(config);

    log.info({ camera: this.cameraName, session: this.id }, 'Session started, waiting for SDP offer...');

    this.registerPostSessionHandlers();
  }

  /** Tear down signaling and the peer connection. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.clearDisconnectGrace();
    this.signaling.removeAllListeners();
    this.signaling.close();

    await this.pc?.close().catch(() => {});
    this.pc = null;
  }

  /**
   * Stand down the disconnect deadline.
   *
   * ⚠️ Must run on close() as well as on recovery: a timer left armed would
   * fire onFailed for a session that has already been torn down and replaced,
   * killing its successor.
   */
  private clearDisconnectGrace(): void {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  private createPeerConnection(config: EndToEndWebrtcConfig): RTCPeerConnection {
    return new RTCPeerConnection({
      iceServers: config.iceServers.flatMap((s) =>
        s.urls.map((url) => ({
          urls: url,
          username: s.username,
          credential: s.credential,
        })),
      ),
      codecs: {
        video: [
          new RTCRtpCodecParameters({
            mimeType: 'video/H264',
            clockRate: 90000,
            payloadType: 96,
          }),
        ],
        audio: [
          new RTCRtpCodecParameters({
            mimeType: 'audio/opus',
            clockRate: 48000,
            channels: 2,
            payloadType: 111,
          }),
          new RTCRtpCodecParameters({
            mimeType: 'audio/PCMU',
            clockRate: 8000,
            payloadType: 0,
          }),
          new RTCRtpCodecParameters({
            mimeType: 'audio/PCMA',
            clockRate: 8000,
            payloadType: 8,
          }),
        ],
      },
    });
  }

  /** Connect signaling — resolve on SESSION_STARTED, reject on close/error. */
  private connectSignaling(config: EndToEndWebrtcConfig): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.signaling.on('sessionStarted', () => resolve());

      this.signaling.on('closed', (_code, reason) => {
        let errorMsg = reason;
        try {
          const parsed = JSON.parse(reason);
          if (parsed.error) errorMsg = parsed.error;
        } catch {}

        reject(new Error(errorMsg));
      });

      this.signaling.on('error', (err) => {
        reject(err);
      });

      this.signaling.connect(
        config.signallingServerUrl,
        config.signallingServerToken,
        config.cameraAuthToken,
      ).catch(reject);
    });
  }

  /** Register SDP/ICE/close handlers after session is established. */
  private registerPostSessionHandlers(): void {
    this.signaling.on('sdpOffer', async (offer) => {
      try {
        await this.handleSdpOffer(offer);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ camera: this.cameraName, session: this.id }, 'SDP handling failed: %s', msg);
      }
    });

    this.signaling.on('iceCandidate', async (candidate) => {
      log.debug({ camera: this.cameraName, session: this.id }, 'Remote ICE candidate received');
      await this.handleRemoteIceCandidate(candidate);
    });

    this.signaling.on('closed', (_code, reason) => {
      log.warn({ camera: this.cameraName, session: this.id, reason }, 'Signaling closed');
    });
  }

  // rtpSubscribed is a one-shot guard: onRemoteTransceiverAdded fires
  // before werift has registered the remote SSRC-backed track, so the
  // first candidate can be a placeholder defaultTrack that never
  // receives RTP. Whichever discovery path fires first wins the
  // subscription, so the real track must win over the placeholder.
  private subscribeToRtp(track: any, source: string): void {
    if (this.rtpSubscribed) return;
    this.rtpSubscribed = true;

    track.onReceiveRtp.subscribe((rtp: any) => {
      this.callbacks.onRtp(this, rtp.serialize());
    });

    log.info({ camera: this.cameraName, session: this.id, source }, 'Video streaming active');
    this.callbacks.onTrackReady?.(this);
  }

  private setupPeerConnection(): void {
    const pc = this.pc!;

    // onRemoteTransceiverAdded fires before werift has registered the remote
    // SSRC-backed track. At that point receiver.track can be a placeholder
    // defaultTrack which never receives RTP. Observe it for diagnostics, but
    // wait for onTrack before subscribing so the real track wins the guard.
    pc.onRemoteTransceiverAdded.subscribe((transceiver) => {
      log.info(
        { camera: this.cameraName, session: this.id, mid: transceiver.mid, kind: transceiver.kind,
          direction: transceiver.direction, hasReceiver: !!transceiver.receiver, hasTrack: !!transceiver.receiver?.track },
        'Remote transceiver added',
      );
    });

    // Method 1: onTrack — werift emits this after it registers the actual
    // remote media track and routes the negotiated SSRC to it.
    pc.onTrack.subscribe((track) => {
      log.info({ camera: this.cameraName, session: this.id, kind: track.kind }, 'onTrack fired');
      if (track.kind === 'video') {
        this.subscribeToRtp(track, 'onTrack');
      }
    });

    // Method 2: ontrack callback — alternative style
    pc.ontrack = (ev) => {
      log.info({ camera: this.cameraName, session: this.id, kind: ev.track.kind }, 'ontrack callback fired');
      if (ev.track.kind === 'video') {
        this.subscribeToRtp(ev.track, 'ontrack callback');
      }
    };

    // Method 3: When connected, scan transceivers as last resort
    pc.connectionStateChange.subscribe((state) => {
      if (state !== 'connected') return;
      log.info({ camera: this.cameraName, session: this.id }, 'Connection connected, scanning transceivers');
      for (const t of pc.getTransceivers()) {
        log.info(
          { camera: this.cameraName, session: this.id, mid: t.mid, kind: t.kind, hasReceiver: !!t.receiver, hasTrack: !!t.receiver?.track },
          'Transceiver state on connected',
        );
        if (t.kind === 'video' && t.receiver?.track) {
          this.subscribeToRtp(t.receiver.track, 'connectionStateChange scan');
        }
      }
    });

    pc.onIceCandidate.subscribe((candidate) => {
      if (!candidate) return;
      log.debug({ camera: this.cameraName, session: this.id }, 'Local ICE candidate generated');
      this.signaling.sendIceCandidate({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      });
    });

    pc.iceConnectionStateChange.subscribe((state) => {
      log.info({ camera: this.cameraName, session: this.id, iceState: state }, 'ICE connection state changed');
    });

    pc.iceGatheringStateChange.subscribe((state) => {
      log.info({ camera: this.cameraName, session: this.id, iceGathering: state }, 'ICE gathering state changed');
    });

    pc.connectionStateChange.subscribe((state) => {
      if (pc !== this.pc) return; // stale PC after close
      log.info({ camera: this.cameraName, session: this.id, connectionState: state }, 'Connection state changed');

      // 🔴 'disconnected' and 'failed' are NOT the same thing. In WebRTC
      // 'disconnected' is the RECOVERABLE state — connectivity checks are
      // failing but ICE has not given up — and 'failed' is the terminal one.
      // Treating both as terminal tore the whole session down on a transient
      // blip, which then costs a fresh video token and a full renegotiation.
      if (state === 'failed') {
        this.clearDisconnectGrace();
        this.callbacks.onFailed?.(this);
        return;
      }

      if (state === 'disconnected') {
        // Already counting: a repeat notification must not restart the clock,
        // or a connection flapping in and out of 'disconnected' would never
        // reach the deadline and would hang here indefinitely.
        if (this.disconnectTimer) return;
        this.disconnectTimer = setTimeout(() => {
          this.disconnectTimer = null;
          if (pc !== this.pc || this.closed) return;
          log.warn(
            { camera: this.cameraName, session: this.id },
            'Still disconnected after %ds — treating as failed',
            ICE_DISCONNECT_GRACE_MS / 1000,
          );
          this.callbacks.onFailed?.(this);
        }, ICE_DISCONNECT_GRACE_MS);
        return;
      }

      // Any other state — notably 'connected' or 'completed' — means it came
      // back. Stand the timer down.
      this.clearDisconnectGrace();
    });
  }

  private async handleSdpOffer(offer: RTCSessionDescriptionLike): Promise<void> {
    const pc = this.pc!;
    log.info({ camera: this.cameraName, session: this.id }, 'SDP offer received, setting remote description');

    // Log the SDP so we can debug codec/track issues
    const mediaLines = offer.sdp.split('\n').filter((l: string) => l.startsWith('m=') || l.startsWith('a=rtpmap'));
    log.info({ camera: this.cameraName, session: this.id, mediaLines }, 'SDP offer media lines');

    // Extract H.264 fmtp before setRemoteDescription, which can synchronously
    // trigger onRemoteTransceiverAdded → subscribeToRtp → onTrackReady.
    this.h264Fmtp = parseH264Fmtp(offer.sdp);
    if (this.h264Fmtp) {
      log.info({ camera: this.cameraName, session: this.id, h264Fmtp: this.h264Fmtp }, 'Parsed H.264 fmtp from SDP offer');
    } else {
      log.warn({ camera: this.cameraName, session: this.id }, 'No H.264 fmtp found in SDP offer, using default');
    }

    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });

    const transceivers = pc.getTransceivers();
    for (const t of transceivers) {
      log.info(
        { camera: this.cameraName, session: this.id, mid: t.mid, kind: t.kind, direction: t.direction },
        'Transceiver after setRemoteDescription',
      );
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Log answer media lines too
    const answerMediaLines = answer.sdp.split('\n').filter((l: string) => l.startsWith('m=') || l.startsWith('a=rtpmap'));
    log.info({ camera: this.cameraName, session: this.id, answerMediaLines }, 'SDP answer media lines');

    this.signaling.sendAnswer({
      type: 'answer',
      sdp: answer.sdp,
    });
    log.info({ camera: this.cameraName, session: this.id }, 'SDP answer sent');
  }

  private async handleRemoteIceCandidate(candidate: RTCIceCandidateLike): Promise<void> {
    if (!this.pc) return;
    try {
      await this.pc.addIceCandidate({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? undefined,
        sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
      } as any);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ camera: this.cameraName, session: this.id }, 'Failed to add ICE candidate: %s', msg);
    }
  }
}
