import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppConfig } from './config.js';

/**
 * index.ts is the only place that turns the loaded go2rtc API credentials into
 * an authenticated client. `loadConfig()` reading them and `Go2rtcApi` sending
 * them are both covered elsewhere; what is covered here is the wiring between,
 * which nothing else exercises. Dropping the credentials argument here would
 * leave every other suite green and produce a bridge whose startup probe
 * (`waitReady()`) 401s forever against a `local_auth: true` go2rtc.
 */

const { go2rtcCtor, state } = vi.hoisted(() => ({
  go2rtcCtor: vi.fn(),
  state: { config: null as unknown as AppConfig },
}));

vi.mock('./config.js', () => ({
  loadConfig: vi.fn(() => state.config),
  go2rtcRtspBaseUrl: vi.fn(() => 'rtsp://rtspuser:rtsppass@192.168.7.42:8554'),
}));

vi.mock('./utils/logger.js', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  }),
  setLogLevel: vi.fn(),
}));

vi.mock('./go2rtc/go2rtc-api.js', () => ({
  Go2rtcApi: class {
    constructor(...args: unknown[]) {
      go2rtcCtor(...args);
    }
    waitReady = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('./auth/alarm-auth.js', () => ({
  AlarmAuth: class {
    destroy = vi.fn();
  },
}));

vi.mock('./auth/token-manager.js', () => ({
  TokenManager: class {},
}));

vi.mock('./camera/camera-manager.js', () => ({
  CameraManager: class {
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    getStatus = vi.fn(() => ({}));
  },
}));

vi.mock('./events/alarm-event-listener.js', () => ({
  AlarmEventListener: class {
    on = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn();
    circuitState = 'closed';
  },
}));

function makeConfig(go2rtc: Partial<AppConfig['go2rtc']>): AppConfig {
  return {
    alarm: { username: 'u', password: 'p' },
    cameras: [],
    go2rtc: { apiUrl: 'http://192.168.7.42:1984', rtspPort: 8554, ...go2rtc },
    logging: { level: 'info' },
  };
}

/** Import index.ts fresh so its top-level `main()` runs against `state.config`. */
async function runMain(): Promise<void> {
  vi.resetModules();
  await import('./index.js');
  // main() is fire-and-forget at module scope; let its awaits settle.
  await vi.advanceTimersByTimeAsync(0);
}

describe('index startup wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    go2rtcCtor.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('forwards the go2rtc API credentials into Go2rtcApi', async () => {
    state.config = makeConfig({ apiUsername: 'apiuser', apiPassword: 'apipass' });

    await runMain();

    expect(go2rtcCtor).toHaveBeenCalledWith('http://192.168.7.42:1984', {
      username: 'apiuser',
      password: 'apipass',
    });
  });

  it('constructs Go2rtcApi without credentials when none are configured', async () => {
    state.config = makeConfig({});

    await runMain();

    expect(go2rtcCtor).toHaveBeenCalledWith('http://192.168.7.42:1984', undefined);
  });

  it('does not send a half-configured credential pair', async () => {
    // A username with no password would produce `Basic dXNlcjo=` — a request
    // that looks authenticated and is not. Better to send nothing.
    state.config = makeConfig({ apiUsername: 'apiuser' });

    await runMain();

    expect(go2rtcCtor).toHaveBeenCalledWith('http://192.168.7.42:1984', undefined);
  });
});

describe('status endpoint misconfiguration', () => {
  // The bridge crash-looped in production because a bad status config threw
  // from the StatusServer CONSTRUCTOR, which is synchronous and was not
  // guarded. Fixing listen() was not enough: NO status misconfiguration may
  // ever take down the bridge it exists to report on.
  it('does not let a status-server construction failure become fatal', async () => {
    const { startStatusServer } = await import('./index.js');
    expect(() =>
      startStatusServer(
        { bindAddress: '0.0.0.0', port: 9090, username: '', password: '' },
        () => ({}),
      ),
    ).not.toThrow();
  });

  it('returns null when the status server could not be started', async () => {
    const { startStatusServer } = await import('./index.js');
    expect(
      startStatusServer(
        { bindAddress: '0.0.0.0', port: 9090, username: '', password: '' },
        () => ({}),
      ),
    ).toBeNull();
  });
});
