import { describe, it, expect, afterEach } from 'vitest';
import { createServer, connect as netConnect, type Server, type Socket } from 'node:net';
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
});
