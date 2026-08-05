import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('go2rtc');

export interface Go2rtcCredentials {
  username: string;
  password: string;
}

/**
 * Lightweight client for the go2rtc REST API.
 * Used for health checks and stream status monitoring.
 */
export class Go2rtcApi {
  private readonly headers: Record<string, string>;

  constructor(
    private readonly baseUrl: string,
    credentials?: Go2rtcCredentials,
  ) {
    this.headers = credentials
      ? {
          Authorization:
            'Basic ' +
            Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64'),
        }
      : {};
  }

  /** Check if go2rtc is reachable. */
  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/streams`, {
        headers: this.headers,
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Get the list of active streams. */
  async getStreams(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/api/streams`, {
      headers: this.headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`go2rtc API error: ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  }

  /**
   * Drive go2rtc's native HomeKit motion sensor (`motion: api` mode).
   *
   * Not a toggle — go2rtc's handler maps the HTTP method directly:
   * POST sets motion detected, DELETE clears it. Firing POST twice is
   * therefore idempotent rather than an on/off flip.
   */
  async setMotion(stream: string, detected: boolean): Promise<void> {
    const url = `${this.baseUrl}/api/homekit/motion?id=${encodeURIComponent(stream)}`;
    const res = await fetch(url, {
      method: detected ? 'POST' : 'DELETE',
      headers: this.headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      throw new Error(`go2rtc motion API error: ${res.status}`);
    }
  }

  /** Wait for go2rtc to become available, with timeout. */
  async waitReady(timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isHealthy()) {
        log.info('go2rtc is ready');
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`go2rtc not ready after ${timeoutMs}ms`);
  }
}
