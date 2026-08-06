import { createServer, type Server } from 'node:http';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('status');

export interface StatusServerOptions {
  /** Address to bind. Never 0.0.0.0 — see the security note below. */
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
 *   2. **Bound to one address**, never `0.0.0.0`. The constructor rejects the
 *      wildcard rather than trusting the operator, because under host
 *      networking there is no compose `ports:` mapping left to confine it.
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
    if (opts.bindAddress === '0.0.0.0' || opts.bindAddress === '::' || opts.bindAddress === '') {
      throw new Error(
        'status.bindAddress must be a specific address, never a wildcard — under host ' +
          'networking there is no port mapping left to confine it.',
      );
    }
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
