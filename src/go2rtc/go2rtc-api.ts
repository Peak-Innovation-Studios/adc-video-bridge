import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('go2rtc');

export interface Go2rtcCredentials {
  username: string;
  password: string;
}

/**
 * One HomeKit accessory as go2rtc reports it.
 *
 * 🔑 `setupCode` and `setupId` are present ONLY while `paired` is 0. go2rtc
 * omits them once an accessory is paired, which is exactly when they stop being
 * useful — so the window in which a pairing secret is served is bounded by
 * go2rtc itself rather than by anything this code has to remember to enforce.
 */
export interface HomekitAccessory {
  stream: string;
  name: string;
  deviceId: string;
  categoryId: string;
  paired: number;
  setupCode?: string;
  setupId?: string;
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

  /**
   * HomeKit accessories and, for unpaired ones, their setup codes.
   *
   * ⚠️ The bridge deliberately cannot read `config/go2rtc.yaml` — that file
   * holds the HomeKit `device_private` and the container with the Alarm.com
   * credentials has no business reading it (`SECURITY_AUDIT.md`). Fetching this
   * over the API preserves that boundary; do not "simplify" it by mounting the
   * file.
   */
  async getHomekitAccessories(): Promise<HomekitAccessory[]> {
    const res = await fetch(`${this.baseUrl}/api/homekit`, {
      headers: this.headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`go2rtc homekit API error: ${res.status}`);

    const body = (await res.json()) as Record<
      string,
      { name?: string; device_id?: string; category_id?: string; paired?: number; setup_code?: string; setup_id?: string }
    >;

    return Object.entries(body ?? {}).map(([stream, v]) => ({
      stream,
      name: v.name ?? stream,
      deviceId: v.device_id ?? '',
      categoryId: v.category_id ?? '17',
      paired: v.paired ?? 0,
      ...(v.setup_code ? { setupCode: v.setup_code } : {}),
      ...(v.setup_id ? { setupId: v.setup_id } : {}),
    }));
  }
}
