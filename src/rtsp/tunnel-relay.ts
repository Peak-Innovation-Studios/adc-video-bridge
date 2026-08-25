import { createServer, isIP, type Server, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { randomBytes } from 'node:crypto';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('rtsp-relay');

/**
 * Alarm.com cameras serve their local stream as RTSP tunnelled over HTTPS —
 * the QuickTime scheme: a `GET` carrying `Accept: application/x-rtsp-tunnelled`
 * that the server holds open and writes raw RTSP down, plus a `POST` on which
 * the client writes base64-encoded RTSP up.
 *
 * This relay presents that as ORDINARY RTSP on a local port, so go2rtc can use
 * its NATIVE client — native H.264 passthrough, in-process HKSV muxing, and no
 * ffmpeg anywhere in the media path. go2rtc cannot speak the tunnel itself: the
 * pinned commit we build contains no `x-rtsp-tunnelled` handling at all, and its
 * `rtsps://` is RTSP-over-TLS *directly*, which these cameras answer with
 * `HTTP/1.1 400 Bad Request`.
 *
 * 🔑 **The relay holds NO camera credentials, deliberately.** It is a byte
 * relay; the camera's own Digest challenge passes through it untouched, so the
 * RTSP client (go2rtc) authenticates end to end and an unauthenticated caller
 * reaching this port gets the camera's own 401. That is also why the request URI
 * must NOT be rewritten anywhere in here — Digest signs the URI, so rewriting it
 * would invalidate every authenticated request. It is the reason each camera
 * needs its own listener rather than one port routing by path.
 */
export interface TunnelRelayOptions {
  /** Stream name. Diagnostics and logs only. */
  name: string;
  /** Camera's LAN address and its per-camera tunnel port. */
  host: string;
  port: number;
  /** RTSP path. Every camera seen so far serves `/s1`. */
  path: string;
  /** Address to listen on INSIDE the container — see `bindAddress` in config. */
  bindAddress: string;
  listenPort: number;
  /**
   * Concurrent client connections. The tunnel to the camera is opened BEFORE
   * the client authenticates (auth is an RTSP-layer exchange that happens over
   * it), so an unauthenticated caller can cost us sockets even though it can
   * never get video. This bounds that.
   */
  maxConnections?: number;
  /** TLS handshake plus HTTP tunnel header exchange. */
  openTimeoutMs?: number;
  /**
   * Reaps a relay with no traffic in either direction. Generous on purpose: a
   * live stream carries data every ~100ms at 10fps, and the widest legitimate
   * gap is between RTSP `SETUP` and `PLAY`.
   */
  idleTimeoutMs?: number;
  /**
   * Bytes a session must carry FROM the camera before it counts as having
   * worked. A session that closes under this delivered nothing usable.
   *
   * 🔑 Small on purpose. This separates "never reached the camera at all"
   * from "streamed video", not "streamed a lot" from "streamed a little" — a
   * reachable camera returns RTSP responses immediately, an unreachable one
   * returns nothing.
   */
  healthyBytes?: number;
  /**
   * Consecutive failed sessions before the relay reports itself unhealthy.
   *
   * 🔴 Consecutive, and never fatal. The camera may come back, so the relay
   * keeps retrying forever; this only decides when it stops doing so SILENTLY.
   */
  unhealthyAfter?: number;
  /**
   * Test seam. Defaults to TLS with certificate verification disabled (see
   * `openTunnel` for why that is required rather than lazy). Tests substitute a
   * plain TCP connection so the framing — header boundary, base64 encoding,
   * backpressure — can be exercised without standing up a certificate
   * authority. Nothing in production passes this.
   */
  connect?: (host: string, port: number, onConnect: () => void) => Socket;
}

export interface TunnelRelayDiagnostics {
  name: string;
  listenPort: number;
  /** `host:port/path`. Safe to log — the relay never holds credentials. */
  target: string;
  listening: boolean;
  connections: number;
  totalConnections: number;
  rejectedConnections: number;
  bytesDown: number;
  bytesUp: number;
  /** Sessions in a row that closed having carried nothing usable from the camera. */
  consecutiveFailures: number;
  /**
   * False once `consecutiveFailures` reaches `unhealthyAfter`.
   * ⚠️ `healthy: false` does NOT mean the relay stopped: it keeps retrying,
   * because the camera may come back. It means stop believing the silence.
   */
  healthy: boolean;
  lastError?: string;
}

/**
 * ⚠️ `rejectUnauthorized: false` is REQUIRED, not laziness. These cameras
 * present a self-signed `CN=www.alarm.com` certificate that expired in December
 * 2024, and nothing about it is under our control. The link is encrypted but
 * NOT authenticated; the protection that matters is the camera's own Digest
 * auth, which rides inside the tunnel and which this relay never touches.
 */
function tlsConnectInsecure(host: string, port: number, onConnect: () => void): Socket {
  return tlsConnect(
    {
      host,
      port,
      // ⚠️ SNI must be OMITTED for an IP literal — Node throws outright ("Setting
      // the TLS ServerName to an IP address is not permitted"), and a camera
      // address is always an IP. Passing it unconditionally made every tunnel
      // fail at connect time while the unit suite stayed green, because the
      // tests inject a plain-TCP connect and never reach this function.
      ...(isIP(host) === 0 ? { servername: host } : {}),
      rejectUnauthorized: false,
    },
    onConnect,
  );
}

const DEFAULTS = {
  maxConnections: 8,
  openTimeoutMs: 10_000,
  idleTimeoutMs: 120_000,
  // 4 KiB: more than an RTSP response exchange, far less than any real video.
  healthyBytes: 4096,
  // At the observed churn of ~2 sessions/minute this reports within ~5 minutes,
  // while riding out a brief blip rather than crying wolf on one bad session.
  unhealthyAfter: 10,
  connect: tlsConnectInsecure,
};

/**
 * The conventional QuickTime value is 32767, and that is what every reference
 * client sends. LIVE555 — which is what these cameras run — treats the POST
 * body as an unbounded stream and ignores this, but a server that ENFORCED it
 * would cut the control channel after roughly 80 RTSP messages, which on a
 * long-lived HKSV session is an hour in rather than at startup. A large value
 * is free if ignored and protective if not.
 */
const POST_CONTENT_LENGTH = 1_000_000_000;

/** `Accept:` is what switches the path into tunnel mode — without it the same path 404s. */
function tunnelGetRequest(host: string, port: number, path: string, cookie: string): string {
  return (
    `GET ${path} HTTP/1.0\r\n` +
    `Host: ${host}:${port}\r\n` +
    `User-Agent: adc-video-bridge\r\n` +
    `x-sessioncookie: ${cookie}\r\n` +
    `Accept: application/x-rtsp-tunnelled\r\n` +
    `Pragma: no-cache\r\n` +
    `Cache-Control: no-cache\r\n\r\n`
  );
}

function tunnelPostRequest(host: string, port: number, path: string, cookie: string): string {
  return (
    `POST ${path} HTTP/1.0\r\n` +
    `Host: ${host}:${port}\r\n` +
    `User-Agent: adc-video-bridge\r\n` +
    `x-sessioncookie: ${cookie}\r\n` +
    `Content-Type: application/x-rtsp-tunnelled\r\n` +
    `Pragma: no-cache\r\n` +
    `Cache-Control: no-cache\r\n` +
    `Content-Length: ${POST_CONTENT_LENGTH}\r\n` +
    `Expires: Sun, 9 Jan 1972 00:00:00 GMT\r\n\r\n`
  );
}

export class TunnelRelay {
  private readonly opts: Required<TunnelRelayOptions>;
  private server: Server | null = null;
  private readonly sessions = new Set<() => void>();
  private totalConnections = 0;
  private rejectedConnections = 0;
  private bytesDown = 0;
  private bytesUp = 0;
  private lastError: string | undefined;
  /**
   * 🔴 The defect this exists for: two cameras were unreachable for up to 17
   * days while this relay opened ~45,000 connections that delivered almost
   * nothing, and NOTHING reported it. `verify:config` said 0 blocking the whole
   * time, because it validates configuration and not liveness.
   * 🔑 The signal was already being collected and thrown away: a working
   * camera holds ONE long connection and moves a lot of data; a dead one churns
   * and moves almost none. That ratio is the health check.
   */
  private consecutiveFailures = 0;
  private unhealthyReported = false;

  constructor(options: TunnelRelayOptions) {
    this.opts = { ...DEFAULTS, ...options };
  }

  get listening(): boolean {
    return this.server?.listening === true;
  }

  getDiagnostics(): TunnelRelayDiagnostics {
    const { name, listenPort, host, port, path } = this.opts;
    return {
      name,
      listenPort,
      target: `${host}:${port}${path}`,
      listening: this.listening,
      connections: this.sessions.size,
      totalConnections: this.totalConnections,
      rejectedConnections: this.rejectedConnections,
      bytesDown: this.bytesDown,
      bytesUp: this.bytesUp,
      consecutiveFailures: this.consecutiveFailures,
      healthy: this.consecutiveFailures < this.opts.unhealthyAfter,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.handleClient(socket));
      server.on('error', (err) => {
        this.lastError = err.message;
        // Only the listen() failure is fatal to start(); later errors on an
        // established listener must not take the bridge down.
        if (!this.listening) reject(err);
        else log.error({ camera: this.opts.name }, 'Relay server error: %s', err.message);
      });
      server.listen(this.opts.listenPort, this.opts.bindAddress, () => {
        // The ASSIGNED port, not the configured one — they differ whenever 0
        // was requested, and a log line that says 0 is worse than no log line.
        const address = server.address();
        const bound = address && typeof address === 'object' ? address.port : this.opts.listenPort;
        log.info(
          {
            camera: this.opts.name,
            listen: `${this.opts.bindAddress}:${bound}`,
            target: `${this.opts.host}:${this.opts.port}${this.opts.path}`,
          },
          'RTSP tunnel relay listening',
        );
        resolve();
      });
      this.server = server;
    });
  }

  async stop(): Promise<void> {
    for (const close of [...this.sessions]) close();
    this.sessions.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handleClient(client: Socket): void {
    if (this.sessions.size >= this.opts.maxConnections) {
      this.rejectedConnections++;
      log.warn(
        { camera: this.opts.name, max: this.opts.maxConnections },
        'Relay connection refused: too many concurrent sessions',
      );
      client.destroy();
      return;
    }

    this.totalConnections++;
    client.setNoDelay(true);

    const cookie = randomBytes(12).toString('base64url');
    let getSock: Socket | null = null;
    let postSock: Socket | null = null;
    let closed = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    // Per-session, NOT the cumulative counter: the question is whether THIS
    // session carried anything, and a lifetime total answers a different one.
    let sessionBytesDown = 0;

    const close = (why?: string) => {
      if (closed) return;
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      this.sessions.delete(close);
      for (const s of [client, getSock, postSock]) s?.destroy();
      if (why) log.debug({ camera: this.opts.name }, 'Relay session closed: %s', why);
      this.recordSessionOutcome(sessionBytesDown, why);
    };
    this.sessions.add(close);

    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => close('idle timeout'), this.opts.idleTimeoutMs);
    };
    touch();

    client.on('error', (err) => close(`client error: ${err.message}`));
    client.on('close', () => close('client closed'));

    // Anything the client sends before the tunnel is up must be held, not
    // dropped — RTSP clients send OPTIONS immediately on connect.
    const preOpen: Buffer[] = [];
    let tunnelReady = false;
    client.on('data', (chunk) => {
      touch();
      if (!tunnelReady) {
        preOpen.push(chunk);
        return;
      }
      this.writeUp(postSock, chunk, client);
    });

    this.openTunnel(cookie, client)
      .then(({ get, post, leftover }) => {
        if (closed) {
          get.destroy();
          post.destroy();
          return;
        }
        getSock = get;
        postSock = post;
        tunnelReady = true;

        get.on('error', (err) => close(`tunnel error: ${err.message}`));
        get.on('close', () => close('tunnel closed'));
        post.on('error', (err) => close(`tunnel error: ${err.message}`));
        post.on('close', () => close('tunnel closed'));

        // Bytes the camera already sent past the HTTP header boundary. Usually
        // none, but dropping them would silently eat the first RTSP response.
        if (leftover.length > 0) {
          sessionBytesDown += leftover.length;
          this.writeDown(client, get, leftover);
        }

        get.on('data', (chunk) => {
          touch();
          sessionBytesDown += chunk.length;
          this.writeDown(client, get, chunk);
        });

        for (const chunk of preOpen) this.writeUp(post, chunk, client);
        preOpen.length = 0;
      })
      .catch((err: Error) => {
        this.lastError = err.message;
        log.warn({ camera: this.opts.name }, 'Relay could not open tunnel: %s', err.message);
        close('tunnel open failed');
      });
  }

  /**
   * Client → camera.
   *
   * 🔴 **Each write is base64-encoded on its own, padding and all.** That is the
   * QuickTime scheme, and LIVE555 resyncs on `=`. The tempting alternative —
   * buffering to a 3-byte boundary so no padding lands mid-stream — DEADLOCKS:
   * the tail of a request is held back waiting for bytes that will never come,
   * because the client is waiting for the response to the request whose last
   * two bytes we are sitting on. Measured: `OPTIONS` happened to be
   * 3-byte-aligned and worked, `DESCRIBE` was not and hung forever.
   */
  private writeUp(post: Socket | null, chunk: Buffer, client: Socket): void {
    if (!post || post.destroyed) return;
    this.bytesUp += chunk.length;
    if (!post.write(chunk.toString('base64'))) {
      client.pause();
      post.once('drain', () => client.resume());
    }
  }

  /**
   * Decide whether a finished session worked, and say so ONCE when a run of
   * them has not.
   *
   * 🔴 Logs at `error` exactly once per unhealthy episode, and once more on
   * recovery. Logging every failed session would reproduce the original problem
   * from the other side: ~45,000 lines nobody reads is as good as silence.
   * 🔑 The relay keeps retrying either way. A camera that is off today may be
   * back tomorrow, and the fix here is to stop failing quietly, not to give up.
   */
  private recordSessionOutcome(sessionBytesDown: number, why?: string): void {
    if (sessionBytesDown >= this.opts.healthyBytes) {
      if (this.unhealthyReported) {
        log.info(
          { camera: this.opts.name, afterFailures: this.consecutiveFailures },
          'Relay recovered: the camera is delivering media again',
        );
      }
      this.consecutiveFailures = 0;
      this.unhealthyReported = false;
      return;
    }

    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.opts.unhealthyAfter && !this.unhealthyReported) {
      this.unhealthyReported = true;
      log.error(
        {
          camera: this.opts.name,
          consecutiveFailures: this.consecutiveFailures,
          target: `${this.opts.host}:${this.opts.port}`,
          lastClose: why,
          lastError: this.lastError,
        },
        'Relay has opened %d consecutive sessions that carried no media — the camera is not ' +
          'reachable or is not streaming. Still retrying. Check it is on the network, then whether ' +
          'its address changed (EHOSTUNREACH on a TCP connect to the target means nothing is there).',
        this.consecutiveFailures,
      );
    }
  }

  /** Camera → client, verbatim: the GET channel carries RTSP responses AND interleaved RTP. */
  private writeDown(client: Socket, get: Socket, chunk: Buffer): void {
    if (client.destroyed) return;
    this.bytesDown += chunk.length;
    if (!client.write(chunk)) {
      get.pause();
      client.once('drain', () => get.resume());
    }
  }

  private openTunnel(
    cookie: string,
    client: Socket,
  ): Promise<{ get: Socket; post: Socket; leftover: Buffer }> {
    const { host, port, path, openTimeoutMs } = this.opts;

    return new Promise((resolve, reject) => {
      // 🔴 `get`/`post` are `let`, initialised to null, and every teardown path
      // goes through `fail()`. An earlier version declared `const get = ...`
      // BELOW the timeout callback that destroyed it: when the timer fired
      // first — an unreachable camera, which is the whole point of the timeout —
      // it hit the temporal dead zone and threw a ReferenceError out of a timer
      // callback, i.e. an uncatchable crash of the whole bridge. Under
      // `restart: unless-stopped` that is a crash loop caused by one offline
      // camera. `settled` exists for the same reason: both sockets can error,
      // and the timer can fire after either.
      let get: Socket | null = null;
      let post: Socket | null = null;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const disarm = () => {
        if (timer) clearTimeout(timer);
        timer = null;
      };

      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        disarm();
        get?.destroy();
        post?.destroy();
        reject(err);
      };

      const settleResolve = (value: { get: Socket; post: Socket; leftover: Buffer }) => {
        if (settled) return;
        settled = true;
        disarm();
        resolve(value);
      };

      timer = setTimeout(
        () => settleReject(new Error(`tunnel open timed out after ${openTimeoutMs}ms`)),
        openTimeoutMs,
      );

      try {
        get = this.opts.connect(host, port, () =>
          get?.write(tunnelGetRequest(host, port, path, cookie)),
        );
      } catch (err) {
        // `connect` can throw synchronously on a malformed option — Node does
        // exactly that for an IP passed as SNI.
        settleReject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      get.setNoDelay(true);
      get.on('error', settleReject);

      let header = Buffer.alloc(0);
      const onHeaderData = (chunk: Buffer) => {
        header = Buffer.concat([header, chunk]);
        const end = header.indexOf('\r\n\r\n');
        if (end < 0) {
          if (header.length > 8192) settleReject(new Error('tunnel response header too large'));
          return;
        }

        get?.off('data', onHeaderData);
        const head = header.subarray(0, end).toString('latin1');
        const leftover = header.subarray(end + 4);

        const status = /^HTTP\/1\.[01] (\d{3})/.exec(head);
        if (!status || status[1] !== '200') {
          settleReject(new Error(`tunnel GET returned ${status?.[1] ?? 'a malformed response'}`));
          return;
        }
        if (!/application\/x-rtsp-tunnelled/i.test(head)) {
          // A 200 without this content type means the port answered as an
          // ordinary web server — i.e. the Accept header did not take effect.
          settleReject(new Error('tunnel GET did not return application/x-rtsp-tunnelled'));
          return;
        }

        try {
          post = this.opts.connect(host, port, () => {
            post?.write(tunnelPostRequest(host, port, path, cookie));
            if (get && post) settleResolve({ get, post, leftover });
          });
        } catch (err) {
          settleReject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        post.setNoDelay(true);
        post.on('error', settleReject);
      };

      get.on('data', onHeaderData);
      client.once('close', () => settleReject(new Error('client closed before the tunnel opened')));
    });
  }
}
