import { createServer, type Server } from 'node:http';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('status');

export interface StatusServerOptions {
  /**
   * Address to bind INSIDE the container. Normally `0.0.0.0`: confinement comes
   * from compose's `ports:` mapping, which binds the host side to one address.
   */
  bindAddress: string;
  port: number;
  username: string;
  password: string;
  /** Called per request; must return only non-sensitive operational data. */
  getStatus: () => unknown;
}

/**
 * A minimal read-only status endpoint, so diagnosing the bridge does not
 * require `docker-compose logs` (and therefore sudo) on the deployment host.
 *
 * 🔴 Adding this reverses a deliberate Phase 0 property — the bridge listened
 * on nothing after the container split. Three constraints keep that regression
 * bounded, and none of them is optional:
 *
 *   1. **Disabled unless explicitly configured.** No accidental listener.
 *   2. **Confined by compose's `ports:` mapping**, which binds the host side to
 *      `ADC_BRIDGE_BIND_ADDRESS` — one address, never the wildcard. ⚠️ The
 *      bind address here is the address INSIDE the container, and the bridge
 *      runs on the default bridge network, where the host's LAN address does
 *      not exist. Binding it there fails with EADDRNOTAVAIL. `0.0.0.0` is the
 *      correct value and is safe precisely because the mapping confines it.
 *      🔴 If you ever move this container to `network_mode: host`, that mapping
 *      disappears and the wildcard becomes a real exposure — bind explicitly.
 *   3. **Authenticated**, with its own credentials — not the go2rtc or
 *      Alarm.com ones, so a leak here cannot move laterally.
 *
 * It is also read-only: GET only, no mutating routes, and the payload carries
 * camera names but never camera IDs or credentials.
 */
export class StatusServer {
  private server: Server | null = null;
  private readonly expected: string;

  constructor(private readonly opts: StatusServerOptions) {
    if (!opts.username || !opts.password) {
      throw new Error('status.username and status.password are required when the status server is enabled.');
    }
    this.expected =
      'Basic ' + Buffer.from(`${opts.username}:${opts.password}`).toString('base64');
  }

  start(): void {
    this.server = createServer((req, res) => {
      if (req.headers.authorization !== this.expected) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="adc-video-bridge"' });
        res.end('Unauthorized');
        return;
      }
      if (req.method !== 'GET') {
        res.writeHead(405).end('Method Not Allowed');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.opts.getStatus()));
    });

    // A diagnostics endpoint must never be able to take down the bridge it
    // reports on. An http.Server 'error' event with NO listener throws, and
    // `listen()` fails asynchronously — so a bad bind address (the realistic
    // case: an address this container does not own) would crash the process
    // and, under `restart: unless-stopped`, crash-loop it.
    this.server.on('error', (err) => {
      log.error(
        { bindAddress: this.opts.bindAddress, port: this.opts.port },
        'Status endpoint failed to start, continuing without it: %s',
        err instanceof Error ? err.message : String(err),
      );
      this.server = null;
    });

    this.server.listen(this.opts.port, this.opts.bindAddress, () => {
      log.info(
        { bindAddress: this.opts.bindAddress, port: this.opts.port },
        'Status endpoint listening',
      );
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
