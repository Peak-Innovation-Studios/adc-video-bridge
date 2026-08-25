import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, connect as netConnect, type Server, type Socket } from 'node:net';

// Held so the once-only reporting can be asserted: a relay that logged every
// failure would reproduce the original problem from the other side.
const { logSpy } = vi.hoisted(() => ({
  logSpy: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/logger.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/logger.js')>('../utils/logger.js');
  return { ...actual, createChildLogger: () => logSpy };
});

import { TunnelRelay } from './tunnel-relay.js';

/**
 * Decodes the upstream channel the way LIVE555 does: the client base64-encodes
 * each write on its own, padding included, and the decoder RESYNCS at every
 * padding run. Modelling it this way rather than decoding the whole stream as
 * one base64 blob is the point — a decoder that required 4-character alignment
 * across the whole stream would accept an implementation that cannot work
 * against a real camera.
 */
function decodeResyncing(base64Stream: string): Buffer {
  const segments = base64Stream.match(/[^=]+={0,2}/g) ?? [];
  return Buffer.concat(segments.map((s) => Buffer.from(s, 'base64')));
}

/** Minimal stand-in for the camera's HTTPS tunnel endpoint, over plain TCP. */
class FakeCamera {
  readonly server: Server;
  port = 0;
  getSocket: Socket | null = null;
  postSocket: Socket | null = null;
  /** Everything the relay sent upstream, base64-decoded. */
  upstream = '';
  private upstreamB64 = '';
  /** Overridable so tests can drive the failure paths. */
  status = 'HTTP/1.1 200 OK';
  contentType = 'application/x-rtsp-tunnelled';
  /** Accept the connection and never answer — an unreachable-camera stand-in. */
  silent = false;
  /** Written in the SAME packet as the tunnel header, to exercise `leftover`. */
  trailing = '';

  constructor() {
    this.server = createServer((socket) => this.accept(socket));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', () => resolve()));
    const address = this.server.address();
    if (address && typeof address === 'object') this.port = address.port;
  }

  async close(): Promise<void> {
    this.getSocket?.destroy();
    this.postSocket?.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private accept(socket: Socket): void {
    let header = '';
    let headerDone = false;

    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (!headerDone) {
        header += chunk.toString('latin1');
        const end = header.indexOf('\r\n\r\n');
        if (end < 0) return;
        headerDone = true;
        const body = header.slice(end + 4);
        header = header.slice(0, end);

        if (header.startsWith('GET ')) {
          this.getSocket = socket;
          if (this.silent) return;
          socket.write(`${this.status}\r\nContent-Type: ${this.contentType}\r\n\r\n${this.trailing}`);
          return;
        }
        this.postSocket = socket;
        if (body) this.consume(body);
        return;
      }
      this.consume(chunk.toString('latin1'));
    });
  }

  private consume(base64Text: string): void {
    this.upstreamB64 += base64Text;
    this.upstream = decodeResyncing(this.upstreamB64).toString('latin1');
  }

  /** Push bytes down the held-open GET channel, exactly as a camera does. */
  send(data: string | Buffer): void {
    this.getSocket?.write(data);
  }
}

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met within timeout');
};

describe('TunnelRelay', () => {
  let camera: FakeCamera | null = null;
  let relay: TunnelRelay | null = null;
  const clients: Socket[] = [];

  const start = async (overrides: Partial<FakeCamera> = {}, relayOpts = {}) => {
    camera = new FakeCamera();
    Object.assign(camera, overrides);
    await camera.listen();
    relay = new TunnelRelay({
      name: 'test-cam',
      host: '127.0.0.1',
      port: camera.port,
      path: '/s1',
      bindAddress: '127.0.0.1',
      listenPort: 0,
      connect: (host, port, onConnect) => netConnect({ host, port }, onConnect),
      ...relayOpts,
    });
    await relay.start();
    // @ts-expect-error reaching into the private handle for the assigned port
    return relay.server.address().port as number;
  };

  const connectClient = (port: number): Promise<Socket> =>
    new Promise((resolve) => {
      const socket = netConnect({ host: '127.0.0.1', port }, () => resolve(socket));
      socket.on('error', () => {});
      clients.push(socket);
    });

  afterEach(async () => {
    for (const c of clients) c.destroy();
    clients.length = 0;
    await relay?.stop();
    await camera?.close();
    relay = null;
    camera = null;
  });

  it('opens the tunnel with the header that switches the path into tunnel mode', async () => {
    const port = await start();
    await connectClient(port);

    await waitFor(() => camera!.getSocket !== null && camera!.postSocket !== null);
    expect(relay!.getDiagnostics().connections).toBe(1);
  });

  it('relays an RTSP request upstream and its response back verbatim', async () => {
    const port = await start();
    const client = await connectClient(port);
    await waitFor(() => camera!.postSocket !== null);

    const request = 'OPTIONS rtsp://127.0.0.1/s1 RTSP/1.0\r\nCSeq: 1\r\n\r\n';
    client.write(request);
    await waitFor(() => camera!.upstream === request);

    const response = 'RTSP/1.0 200 OK\r\nCSeq: 1\r\nPublic: OPTIONS, DESCRIBE\r\n\r\n';
    const received: Buffer[] = [];
    client.on('data', (b) => received.push(b));
    camera!.send(response);

    await waitFor(() => Buffer.concat(received).toString() === response);
  });

  /**
   * 🔴 REGRESSION. Buffering the upstream to a 3-byte boundary — so no base64
   * padding lands mid-stream — deadlocks, and it deadlocks SELECTIVELY: a
   * request that happens to be 3-byte aligned goes through, so the bug hides
   * behind whichever message the client happens to send first. Both lengths are
   * asserted here for exactly that reason; the misaligned one is the guard.
   */
  it('delivers requests whose length is not a multiple of three', async () => {
    const port = await start();
    const client = await connectClient(port);
    await waitFor(() => camera!.postSocket !== null);

    const aligned = 'A'.repeat(9);
    expect(aligned.length % 3).toBe(0);
    client.write(aligned);
    await waitFor(() => camera!.upstream === aligned);

    const misaligned = 'DESCRIBE rtsp://127.0.0.1/s1 RTSP/1.0\r\nCSeq: 2\r\n\r\n';
    expect(misaligned.length % 3).not.toBe(0);
    client.write(misaligned);
    await waitFor(() => camera!.upstream === aligned + misaligned);
  });

  it('delivers a request split across two writes', async () => {
    const port = await start();
    const client = await connectClient(port);
    await waitFor(() => camera!.postSocket !== null);

    const request = 'PLAY rtsp://127.0.0.1/s1 RTSP/1.0\r\nCSeq: 3\r\n\r\n';
    const cut = 7;
    client.write(request.slice(0, cut));
    await waitFor(() => camera!.upstream === request.slice(0, cut));
    client.write(request.slice(cut));

    await waitFor(() => camera!.upstream === request);
  });

  it('holds requests the client sends before the tunnel is open', async () => {
    const port = await start();
    const client = await connectClient(port);

    // Written immediately — RTSP clients send OPTIONS on connect, well before
    // the tunnel's own HTTP handshake has finished.
    const request = 'OPTIONS rtsp://127.0.0.1/s1 RTSP/1.0\r\nCSeq: 1\r\n\r\n';
    client.write(request);

    await waitFor(() => camera!.upstream === request);
  });

  it('does not drop camera bytes that arrive in the tunnel header packet', async () => {
    const trailing = 'RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\n\r\n';
    const port = await start({ trailing });
    const client = await connectClient(port);

    const received: Buffer[] = [];
    client.on('data', (b) => received.push(b));

    await waitFor(() => Buffer.concat(received).toString() === trailing);
  });

  it('closes the client when the tunnel GET is not 200', async () => {
    const port = await start({ status: 'HTTP/1.1 404 Not Found' });
    const client = await connectClient(port);

    await new Promise<void>((resolve) => client.on('close', () => resolve()));
    expect(relay!.getDiagnostics().lastError).toMatch(/404/);
  });

  it('closes the client when the response is not an RTSP tunnel', async () => {
    // A 200 with the wrong content type means the Accept header did not take
    // effect and the port answered as an ordinary web server.
    const port = await start({ contentType: 'text/html' });
    const client = await connectClient(port);

    await new Promise<void>((resolve) => client.on('close', () => resolve()));
    expect(relay!.getDiagnostics().lastError).toMatch(/x-rtsp-tunnelled/);
  });

  it('refuses connections past maxConnections', async () => {
    const port = await start({}, { maxConnections: 1 });
    await connectClient(port);
    await waitFor(() => relay!.getDiagnostics().connections === 1);

    const second = await connectClient(port);
    await new Promise<void>((resolve) => second.on('close', () => resolve()));

    const diagnostics = relay!.getDiagnostics();
    expect(diagnostics.rejectedConnections).toBe(1);
    expect(diagnostics.connections).toBe(1);
  });

  it('reports its target without credentials, because it holds none', async () => {
    const port = await start();
    await connectClient(port);
    await waitFor(() => camera!.postSocket !== null);

    const diagnostics = relay!.getDiagnostics();
    expect(diagnostics.target).toBe(`127.0.0.1:${camera!.port}/s1`);
    expect(diagnostics.target).not.toMatch(/@/);
    expect(diagnostics.listening).toBe(true);
    expect(diagnostics.totalConnections).toBe(1);
  });

  it('stop() closes the listener and any in-flight session', async () => {
    const port = await start();
    const client = await connectClient(port);
    await waitFor(() => camera!.postSocket !== null);

    const closed = new Promise<void>((resolve) => client.on('close', () => resolve()));
    await relay!.stop();
    await closed;

    expect(relay!.listening).toBe(false);
    expect(relay!.getDiagnostics().connections).toBe(0);

    // The port is genuinely gone, not merely marked down.
    const refused = await new Promise<string>((resolve) => {
      const probe = netConnect({ host: '127.0.0.1', port }, () => resolve('connected'));
      probe.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'));
      clients.push(probe);
    });
    expect(refused).toBe('ECONNREFUSED');
  });

  /**
   * 🔴 REGRESSION — this crashed the PROCESS, it did not merely fail. The open
   * timeout's callback destroyed a socket declared with `const` further down
   * the same scope, so when the timer won the race (an unreachable camera —
   * precisely what the timeout exists for) it threw a ReferenceError out of a
   * timer callback, where nothing can catch it. Under `restart: unless-stopped`
   * one offline camera would have crash-looped the whole bridge.
   */
  it('times out cleanly when the camera accepts but never answers', async () => {
    const port = await start({ silent: true }, { openTimeoutMs: 150 });
    const client = await connectClient(port);

    await new Promise<void>((resolve) => client.on('close', () => resolve()));

    expect(relay!.getDiagnostics().lastError).toMatch(/timed out/);
    // Still serving: the failed session must not have taken the listener with it.
    expect(relay!.listening).toBe(true);
    expect(relay!.getDiagnostics().connections).toBe(0);
  });

  /**
   * 🔴 REGRESSION for the bug the whole suite structurally could not see: every
   * other test injects a plain-TCP `connect`, so the REAL default — TLS — was
   * never exercised, and it failed on the very first thing production does.
   * Node refuses `servername` for an IP literal, and a camera address is always
   * an IP. This drives the default connect deliberately; the target refuses the
   * connection, so what is asserted is WHICH error comes back.
   */
  it('does not pass an IP address as TLS SNI', async () => {
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()));
    const closedPort = (dead.address() as { port: number }).port;
    await new Promise<void>((r) => dead.close(() => r()));

    // No `connect` override: this is the production TLS path.
    relay = new TunnelRelay({
      name: 'sni',
      host: '127.0.0.1',
      port: closedPort,
      path: '/s1',
      bindAddress: '127.0.0.1',
      listenPort: 0,
      openTimeoutMs: 1_000,
    });
    await relay.start();
    // @ts-expect-error reaching into the private handle for the assigned port
    const client = await connectClient(relay.server.address().port as number);
    await new Promise<void>((resolve) => client.on('close', () => resolve()));

    const lastError = relay.getDiagnostics().lastError ?? '';
    expect(lastError).not.toMatch(/ServerName/i);
    expect(lastError).toMatch(/ECONNREFUSED|refused/i);
  });

  it('counts bytes in both directions', async () => {
    const port = await start();
    const client = await connectClient(port);
    await waitFor(() => camera!.postSocket !== null);

    client.write('OPTIONS * RTSP/1.0\r\n\r\n');
    camera!.send('RTSP/1.0 200 OK\r\n\r\n');

    await waitFor(() => {
      const d = relay!.getDiagnostics();
      return d.bytesUp > 0 && d.bytesDown > 0;
    });
  });

  /**
   * 🔴 The defect these cover: two cameras were unreachable for up to 17 days
   * while the relay opened ~45,000 connections that carried almost nothing, and
   * NOTHING reported it. `verify:config` said 0 blocking throughout, because it
   * validates configuration and not liveness.
   */
  describe('TunnelRelay health escalation', () => {
    const failOnce = async (port: number) => {
      const client = await connectClient(port);
      await new Promise<void>((resolve) => client.on('close', () => resolve()));
    };

    it('counts sessions that carry nothing from the camera', async () => {
      const port = await start({ silent: true }, { openTimeoutMs: 60, unhealthyAfter: 3 });
      await failOnce(port);
      expect(relay!.getDiagnostics().consecutiveFailures).toBe(1);
      await failOnce(port);
      expect(relay!.getDiagnostics().consecutiveFailures).toBe(2);
    });

    it('reports unhealthy once the run reaches the threshold, and keeps listening', async () => {
      const port = await start({ silent: true }, { openTimeoutMs: 60, unhealthyAfter: 3 });
      for (let i = 0; i < 2; i++) await failOnce(port);
      expect(relay!.getDiagnostics().healthy, 'must not cry wolf before the threshold').toBe(true);

      await failOnce(port);
      expect(relay!.getDiagnostics().healthy).toBe(false);
      // 🔴 Unhealthy must NOT mean "stopped". The camera may come back.
      expect(relay!.listening).toBe(true);
    });

    /**
     * Positive control. Without it, an implementation that reported unhealthy
     * unconditionally would pass every test above.
     */
    it('stays healthy when the camera actually delivers', async () => {
      const port = await start({ trailing: 'x'.repeat(8192) }, { unhealthyAfter: 3, healthyBytes: 4096 });
      const client = await connectClient(port);
      await new Promise((r) => setTimeout(r, 120));
      client.destroy();
      await new Promise((r) => setTimeout(r, 60));

      const d = relay!.getDiagnostics();
      expect(d.consecutiveFailures).toBe(0);
      expect(d.healthy).toBe(true);
    });

    it('resets the run after a session that works, so a blip does not accumulate', async () => {
      const port = await start({ silent: true }, { openTimeoutMs: 60, unhealthyAfter: 5 });
      await failOnce(port);
      await failOnce(port);
      expect(relay!.getDiagnostics().consecutiveFailures).toBe(2);

      // The camera starts answering.
      camera!.silent = false;
      camera!.trailing = 'x'.repeat(8192);
      const client = await connectClient(port);
      await new Promise((r) => setTimeout(r, 120));
      client.destroy();
      await new Promise((r) => setTimeout(r, 60));

      expect(relay!.getDiagnostics().consecutiveFailures).toBe(0);
      expect(relay!.getDiagnostics().healthy).toBe(true);
    });

    /**
     * 🔴 Covers the STREAMING path specifically. The tests above deliver their
     * bytes via `trailing`, which arrives in the tunnel-header packet and is
     * counted through `leftover` — so removing the accumulation in
     * `get.on('data')` broke none of them. That mutation survived once.
     * It matters more than it looks: if the streaming path stopped counting,
     * a HEALTHY camera would be declared unhealthy after N sessions.
     */
    it('counts bytes that arrive AFTER the tunnel opens, not just with the header', async () => {
      const port = await start({}, { unhealthyAfter: 2, healthyBytes: 4096 });
      const client = await connectClient(port);
      await new Promise((r) => setTimeout(r, 120));

      expect(camera!.getSocket, 'tunnel never opened').not.toBeNull();
      camera!.getSocket!.write('x'.repeat(8192));
      await new Promise((r) => setTimeout(r, 120));

      client.destroy();
      await new Promise((r) => setTimeout(r, 80));

      const d = relay!.getDiagnostics();
      expect(d.consecutiveFailures, 'streamed bytes must count as a working session').toBe(0);
      expect(d.healthy).toBe(true);
    });

    /**
     * 🔴 THE REGRESSION. Counting failed sessions is not enough: a camera
     * nobody connects to produces NO failed sessions, so a failure-count-only
     * check reported two definitively dead cameras as healthy. Measured live
     * 2026-08-25, on the very first deploy of that check.
     */
    it('reports unhealthy after silence even with ZERO sessions', async () => {
      const port = await start({}, { stalledAfterMs: 100 });
      expect(port).toBeGreaterThan(0);

      // Nothing ever connects. consecutiveFailures stays 0 the whole time.
      expect(relay!.getDiagnostics().healthy).toBe(true);
      await new Promise((r) => setTimeout(r, 160));

      const d = relay!.getDiagnostics();
      expect(d.consecutiveFailures, 'no sessions means no failures to count').toBe(0);
      expect(d.healthy, 'silence alone must be enough to report unhealthy').toBe(false);
      expect(d.msSinceDelivery).toBeGreaterThanOrEqual(100);
    });

    it('checkStalled logs once per episode, not on every tick', async () => {
      logSpy.error.mockClear();
      await start({}, { stalledAfterMs: 100 });
      await new Promise((r) => setTimeout(r, 160));

      relay!.checkStalled();
      relay!.checkStalled();
      relay!.checkStalled();
      expect(logSpy.error).toHaveBeenCalledTimes(1);
    });

    /**
     * Positive control, and it has to outlast the threshold to mean anything.
     * ⚠️ A first version ran 240ms against a 400ms window, so it could never
     * have detected a frozen delivery clock: the stall would not have fired
     * either way. That mutation survived. This keeps media flowing for LONGER
     * than `stalledAfterMs`, so only a clock that actually updates keeps it
     * healthy.
     */
    it('stays healthy while media keeps arriving, past the stall window', async () => {
      const port = await start({}, { stalledAfterMs: 200 });
      const client = await connectClient(port);
      await new Promise((r) => setTimeout(r, 120));
      expect(camera!.getSocket, 'tunnel never opened').not.toBeNull();

      // ~400ms of traffic against a 200ms window.
      for (let i = 0; i < 5; i++) {
        camera!.getSocket!.write('x'.repeat(2048));
        await new Promise((r) => setTimeout(r, 80));
      }

      const d = relay!.getDiagnostics();
      expect(d.msSinceDelivery, 'the delivery clock must be moving').toBeLessThan(200);
      expect(d.healthy).toBe(true);
      client.destroy();
    });

    it('stalledAfterMs: 0 disables the stall check, for on-demand deployments', async () => {
      await start({}, { stalledAfterMs: 0 });
      await new Promise((r) => setTimeout(r, 120));
      expect(relay!.getDiagnostics().healthy).toBe(true);
    });

    it('a short session that carried nothing counts as a failure, not a success', async () => {
      // ⚠️ The distinction that matters: "closed quickly" is not the signal,
      // "closed having delivered nothing" is. A reachable camera answers RTSP
      // immediately; an unreachable one returns nothing however long you wait.
      const port = await start({ silent: true }, { openTimeoutMs: 60, unhealthyAfter: 10 });
      await failOnce(port);
      expect(relay!.getDiagnostics().consecutiveFailures).toBe(1);
      expect(relay!.getDiagnostics().healthy).toBe(true);
    });
  });

});
